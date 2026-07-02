import net from "node:net";
import type { RuntimeClient } from "@devin/agent-sdk";
import {
  buildPreviewUrl,
  generatePreviewSlug,
  previewDeployEnabled,
  registerPreviewRoute,
  type PreviewRoute,
} from "./preview-registry.js";

export interface PreviewDeployResult {
  slug: string;
  previewUrl: string;
  upstreamHost: string;
  upstreamPort: number;
}

export interface PreviewDeployEmitter {
  (
    type: "deploy.building" | "deploy.ready" | "deploy.failed",
    message: string,
    data?: Record<string, unknown>,
  ): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePackageScripts(stdout: string): Record<string, string> | null {
  try {
    const pkg = JSON.parse(stdout) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return null;
  }
}

async function waitForTcpPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port }, () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
        socket.setTimeout(2_000, () => {
          socket.destroy();
          reject(new Error("connect timeout"));
        });
      });
      return true;
    } catch {
      await sleep(2_000);
    }
  }
  return false;
}

function resolveStartCommand(
  scripts: Record<string, string> | null,
  port: number,
): string {
  if (scripts?.start) {
    return `nohup env PORT=${port} NODE_ENV=production npm start > /workspace/preview.log 2>&1 &`;
  }
  if (scripts?.["start:prod"]) {
    return `nohup env PORT=${port} NODE_ENV=production npm run start:prod > /workspace/preview.log 2>&1 &`;
  }
  if (scripts?.build) {
    return `nohup npx --yes serve@14 dist -l ${port} > /workspace/preview.log 2>&1 &`;
  }
  return `nohup env PORT=${port} NODE_ENV=production node src/index.js > /workspace/preview.log 2>&1 &`;
}

export async function deployProductionPreview(input: {
  runtime: RuntimeClient;
  taskId: string;
  repoCwd: string;
  guestHost: string;
  emit: PreviewDeployEmitter;
}): Promise<PreviewDeployResult | null> {
  if (!previewDeployEnabled()) {
    return null;
  }

  const port = Number(process.env.PREVIEW_APP_PORT ?? 3000);
  const { runtime, taskId, repoCwd, guestHost, emit } = input;

  const pkgResult = await runtime.terminal({
    taskId,
    command: "test -f package.json && cat package.json || echo '{}'",
    cwd: repoCwd,
  });

  const scripts = parsePackageScripts(pkgResult.stdout);
  if (!scripts) {
    emit("deploy.failed", "Skipped preview deploy — no package.json found", {
      reason: "no_package_json",
    });
    return null;
  }

  emit("deploy.building", "Running production build for preview deploy", {
    guestHost,
    port,
  });

  try {
    await runtime.terminal({
      taskId,
      command:
        "npm ci --omit=dev 2>/dev/null || npm install --omit=dev 2>/dev/null || npm install",
      cwd: repoCwd,
    });

    if (scripts.build) {
      const buildResult = await runtime.terminal({
        taskId,
        command: "npm run build",
        cwd: repoCwd,
      });
      if (buildResult.exitCode !== 0) {
        throw new Error(
          buildResult.stderr.trim() ||
            buildResult.stdout.trim() ||
            "production build failed",
        );
      }
    }

    const startCommand = resolveStartCommand(scripts, port);
    await runtime.terminal({
      taskId,
      command: startCommand,
      cwd: repoCwd,
    });

    const ready = await waitForTcpPort(guestHost, port, 90_000);
    if (!ready) {
      throw new Error(
        `preview app did not start on ${guestHost}:${port} within 90s`,
      );
    }

    const slug = generatePreviewSlug();
    const previewUrl = buildPreviewUrl(slug);
    const route: PreviewRoute = {
      slug,
      taskId,
      upstreamHost: guestHost,
      upstreamPort: port,
      previewUrl,
      createdAt: new Date().toISOString(),
    };
    registerPreviewRoute(route);

    emit("deploy.ready", "Preview deployment is live", {
      previewUrl,
      slug,
      upstreamHost: guestHost,
      upstreamPort: port,
    });

    return {
      slug,
      previewUrl,
      upstreamHost: guestHost,
      upstreamPort: port,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Preview deploy failed";
    emit("deploy.failed", message, { error: message });
    return null;
  }
}
