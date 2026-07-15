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
 *
 * Embedded as a nested heredoc inside PREVIEW_START — never chain with
 * `NODE && ...` on the terminator line (that feeds shell text into node).
 */
const MATERIALIZE_JS_BODY = `const fs = require('fs');
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
}`;

/**
 * Clear stale npm locks and install deps for preview. Keep this short — the
 * prior /proc walk + long preinstall blocked greenfield tasks for 10+ minutes.
 */
export const ENSURE_NPM_DEPENDENCIES_COMMAND = `sh <<'ENSURE_NPM'
set +e
rm -rf "\$HOME/.npm/_locks" node_modules/.package-lock.json 2>/dev/null || true
if node -e "try{const p=require('./package.json');const d=Object.keys(p.dependencies||{});for (const x of d) require.resolve(x); process.exit(0)}catch{process.exit(1)}"; then
  echo 'reusing resolved node_modules'
  exit 0
fi
rm -rf node_modules
export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--dns-result-order=ipv4first"
export npm_config_fetch_retries=2
export npm_config_fetch_timeout=30000
export npm_config_network_timeout=30000
timeout -k 10 60 npm install --omit=dev --no-audit --no-fund --progress=false --loglevel error
ENSURE_NPM`;

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

  // One quoted outer heredoc. Nested NODE heredoc terminator is alone on its
  // line so node never sees `NODE && nohup ...` as source.
  return `sh <<'PREVIEW_START'
set +e
if [ -f /workspace/preview.pid ]; then
  kill "$(cat /workspace/preview.pid)" 2>/dev/null || true
fi
node <<'NODE'
${MATERIALIZE_JS_BODY}
NODE
if command -v nohup >/dev/null 2>&1; then
  nohup ${launch} >/workspace/preview.log 2>&1 &
else
  ${launch} >/workspace/preview.log 2>&1 &
fi
echo $! >/workspace/preview.pid
PREVIEW_START`;
}

async function waitForPreviewReady(
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  // One in-guest loop — not N scheduler↔runtime RPCs (each cost seconds and
  // previously stretched a 90s ready wait into ~9 minutes).
  const seconds = Math.max(5, Math.ceil(timeoutMs / 1000));
  const probe = await runtime.terminalAllowFailure({
    taskId,
    cwd: repoCwd,
    command: [
      "set +e",
      `for i in $(seq 1 ${seconds}); do`,
      `  if curl -sf --max-time 2 http://127.0.0.1:${port}/health >/dev/null; then exit 0; fi`,
      `  if curl -sf --max-time 2 http://127.0.0.1:${port}/ >/dev/null; then exit 0; fi`,
      "  sleep 1",
      "done",
      "exit 1",
    ].join("\n"),
  });
  return probe.exitCode === 0;
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

export async function ensureNpmDependencies(input: {
  runtime: RuntimeClient;
  taskId: string;
  repoCwd: string;
}): Promise<{ ok: boolean; detail: string }> {
  const result = await input.runtime.terminalAllowFailure({
    taskId: input.taskId,
    cwd: input.repoCwd,
    command: ENSURE_NPM_DEPENDENCIES_COMMAND,
  });
  const detail = (result.stderr || result.stdout || "").trim();
  if (result.exitCode === 0) {
    return { ok: true, detail: detail || "ok" };
  }
  if (result.exitCode === 124) {
    return {
      ok: false,
      detail:
        detail ||
        "npm install timed out after 60s (check sandbox egress to registry.npmjs.org)",
    };
  }
  return {
    ok: false,
    detail: detail || `npm install failed with exit code ${result.exitCode}`,
  };
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
    const install = await ensureNpmDependencies({ runtime, taskId, repoCwd });
    if (!install.ok) {
      throw new Error(install.detail);
    }

    if (scripts.build) {
      const buildResult = await runtime.terminalAllowFailure({
        taskId,
        command: "timeout -k 15 120 npm run build",
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
      90_000,
    );
    if (!ready) {
      const previewLog = await readPreviewLog(runtime, taskId, repoCwd);
      throw new Error(
        `preview app did not become ready on port ${port} within 90s` +
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
