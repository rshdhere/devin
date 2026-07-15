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

/**
 * Agents often write CommonJS sources as `.ts`. Node cannot run those with
 * `npm start` (`node src/index.ts`). Materialize sibling `.js` files and rewrite
 * package.json scripts before starting the preview process.
 */
const MATERIALIZE_JS_FROM_TS = `node <<'NODE'
const fs = require('fs');
const path = require('path');
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.ts')) {
      const js = p.slice(0, -3) + '.js';
      if (!fs.existsSync(js)) fs.copyFileSync(p, js);
    }
  }
}
walk('.');
if (fs.existsSync('package.json')) {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const [key, value] of Object.entries(pkg.scripts)) {
      if (typeof value === 'string') {
        pkg.scripts[key] = value.replace(/\\.ts\\b/g, '.js');
      }
    }
  }
  if (typeof pkg.main === 'string') {
    pkg.main = pkg.main.replace(/\\.ts\\b/g, '.js');
  }
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');
}
NODE`;

function resolveStartCommand(
  scripts: Record<string, string> | null,
  port: number,
): string {
  const launch = (() => {
    if (scripts?.start) {
      return `env PORT=${port} HOST=0.0.0.0 NODE_ENV=production npm start`;
    }
    if (scripts?.["start:prod"]) {
      return `env PORT=${port} HOST=0.0.0.0 NODE_ENV=production npm run start:prod`;
    }
    if (scripts?.build) {
      return `npx --yes serve@14 dist -l tcp://0.0.0.0:${port}`;
    }
    return `env PORT=${port} HOST=0.0.0.0 NODE_ENV=production node src/index.js`;
  })();

  return (
    `if [ -f /workspace/preview.pid ]; then kill "$(cat /workspace/preview.pid)" 2>/dev/null || true; fi; ` +
    `${MATERIALIZE_JS_FROM_TS} && ` +
    `nohup ${launch} > /workspace/preview.log 2>&1 & echo $! > /workspace/preview.pid`
  );
}

async function waitForPreviewReady(
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await runtime.terminalAllowFailure({
      taskId,
      cwd: repoCwd,
      command:
        `curl -sf --max-time 2 http://127.0.0.1:${port}/health ` +
        `|| curl -sf --max-time 2 http://127.0.0.1:${port}/ ` +
        `|| exit 1`,
    });
    if (probe.exitCode === 0) {
      return true;
    }
    await sleep(2_000);
  }
  return false;
}

async function readPreviewLog(
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
): Promise<string> {
  const result = await runtime.terminalAllowFailure({
    taskId,
    cwd: repoCwd,
    command:
      "tail -n 80 /workspace/preview.log 2>/dev/null || echo '(no preview.log)'",
  });
  return (result.stdout || result.stderr || "").trim();
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
    // Reuse agent-installed node_modules when present. Avoid a 3-stage
    // install chain that can stall a single HTTP /terminal past Bun's old
    // 5-minute fetch ceiling.
    const install = await runtime.terminalAllowFailure({
      taskId,
      command:
        "if [ -d node_modules ]; then " +
        "echo 'reusing existing node_modules'; " +
        "else " +
        "timeout 240 npm install --omit=dev --no-audit --no-fund " +
        "|| timeout 240 npm install --no-audit --no-fund; " +
        "fi",
      cwd: repoCwd,
    });
    if (install.exitCode !== 0) {
      throw new Error(
        install.stderr.trim() ||
          install.stdout.trim() ||
          "npm install failed (or timed out after 240s)",
      );
    }

    if (scripts.build) {
      const buildResult = await runtime.terminalAllowFailure({
        taskId,
        command: "timeout 240 npm run build",
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

    const ready = await waitForPreviewReady(
      runtime,
      taskId,
      repoCwd,
      port,
      120_000,
    );
    if (!ready) {
      const previewLog = await readPreviewLog(runtime, taskId, repoCwd);
      throw new Error(
        `preview app did not become ready on port ${port} within 120s` +
          (previewLog ? `: ${previewLog}` : ""),
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
