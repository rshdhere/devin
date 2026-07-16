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
# Skip registry entirely when package.json has no installable deps.
if node -e "const p=require('./package.json'); const d={...(p.dependencies||{}),...(p.devDependencies||{})}; process.exit(Object.keys(d).length?1:0)"; then
  echo 'no dependencies — skipping npm install'
  exit 0
fi
if node -e "try{const p=require('./package.json');const d=Object.keys({...(p.dependencies||{}),...(p.devDependencies||{})});for (const x of d) require.resolve(x); process.exit(0)}catch{process.exit(1)}"; then
  echo 'reusing resolved node_modules'
  exit 0
fi
rm -rf node_modules
export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--dns-result-order=ipv4first"
export npm_config_fetch_retries=1
export npm_config_fetch_timeout=15000
export npm_config_network_timeout=15000
# Process-group kill so orphan npm children cannot outlive the deadline.
if command -v timeout >/dev/null 2>&1; then
  timeout -k 5 45 npm install --omit=dev --no-audit --no-fund --progress=false --loglevel error
else
  npm install --omit=dev --no-audit --no-fund --progress=false --loglevel error &
  npid=\$!
  (
    sleep 45
    kill -TERM -\$npid 2>/dev/null || kill -TERM \$npid 2>/dev/null || true
    sleep 5
    kill -KILL -\$npid 2>/dev/null || kill -KILL \$npid 2>/dev/null || true
  ) &
  waiter=\$!
  wait \$npid
  ec=\$?
  kill \$waiter 2>/dev/null || true
  exit \$ec
fi
ENSURE_NPM`;

function packageHasInstallableDeps(pkgStdout: string): boolean {
  try {
    const pkg = JSON.parse(pkgStdout) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    return Object.keys(deps).length > 0;
  } catch {
    return true;
  }
}

function resolveStartCommand(
  scripts: Record<string, string> | null,
  port: number,
  pkgStdout: string,
): string {
  const launch = (() => {
    // Prefer direct node for zero-dep / simple apps — npm start adds overhead
    // and can hang if npm itself is broken in the guest.
    try {
      const pkg = JSON.parse(pkgStdout) as {
        main?: string;
        scripts?: Record<string, string>;
      };
      const deps = packageHasInstallableDeps(pkgStdout);
      const main = typeof pkg.main === "string" ? pkg.main : "";
      if (!deps && main) {
        return `env PORT=${port} HOST=0.0.0.0 NODE_ENV=production node ${main}`;
      }
      const start = pkg.scripts?.start ?? scripts?.start;
      if (typeof start === "string" && /^node\s+\S+/.test(start.trim())) {
        return `env PORT=${port} HOST=0.0.0.0 NODE_ENV=production ${start.trim()}`;
      }
    } catch {
      // fall through
    }
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
        "npm install timed out after 45s (check sandbox egress to registry.npmjs.org)",
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

  const needsNpm = packageHasInstallableDeps(pkgResult.stdout);
  emit("deploy.building", "Starting preview process", {
    guestHost,
    port,
    needsNpm,
  });

  try {
    if (needsNpm) {
      const install = await ensureNpmDependencies({ runtime, taskId, repoCwd });
      if (!install.ok) {
        throw new Error(install.detail);
      }
    } else {
      emit(
        "deploy.building",
        "Skipping npm install (no package dependencies)",
        {
          guestHost,
          port,
        },
      );
    }

    if (scripts.build && needsNpm) {
      const buildResult = await runtime.terminalAllowFailure({
        taskId,
        command: "timeout -k 10 90 npm run build",
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

    const startCommand = resolveStartCommand(scripts, port, pkgResult.stdout);
    await runtime.terminal({
      taskId,
      command: startCommand,
      cwd: repoCwd,
    });

    const readyTimeoutMs = needsNpm ? 45_000 : 20_000;
    const ready = await waitForPreviewReady(
      runtime,
      taskId,
      repoCwd,
      port,
      readyTimeoutMs,
    );
    if (!ready) {
      const previewLog = await readPreviewLog(runtime, taskId, repoCwd);
      throw new Error(
        `preview app did not become ready on port ${port} within ${readyTimeoutMs / 1000}s` +
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
