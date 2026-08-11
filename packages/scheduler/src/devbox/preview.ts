/** Well-known app ports probed before arbitrary listeners. */
export const COMMON_DEVBOX_PORTS = [
  3000, 8000, 5173, 8080, 5000, 4173, 3001, 3002, 4200, 9000, 8888, 1313, 4321,
  24678,
] as const;

/** Runtime supervisor port — must never be treated as the product app. */
export const RUNTIME_SUPERVISOR_PORTS = [8081, 8090] as const;

function commonPortsShellList(): string {
  return COMMON_DEVBOX_PORTS.join(" ");
}

function skipPortsShellList(): string {
  return RUNTIME_SUPERVISOR_PORTS.join(" ");
}

/**
 * Shared shell helpers for discover/wait: skip supervisor ports, prefer COMMON
 * app ports, and require a real HTTP response (prefer `/` over `/health` alone
 * so runtime `:8081/health` is never mistaken for the product).
 */
function portProbeHelpers(): string[] {
  return [
    `COMMON='${commonPortsShellList()}'`,
    `SKIP='${skipPortsShellList()}'`,
    'SKIP="$SKIP ${RUNTIME_PORT:-}"',
    "is_skipped() {",
    '  case " $SKIP " in',
    '    *" $1 "*) return 0 ;;',
    "  esac",
    "  return 1",
    "}",
    "try_port() {",
    "  p=$1",
    '  if is_skipped "$p"; then return 1; fi',
    "  # Prefer / (product UI) — supervisor only exposes /health.",
    "  for path in / /api/health /health; do",
    "    code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: identity' --max-time 2 \"http://127.0.0.1:$p$path\" 2>/dev/null || true)",
    '    if echo "$code" | grep -qE "^(200|30[0-9])"; then',
    '      if [ "$path" = "/health" ]; then',
    "        root=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: identity' --max-time 2 \"http://127.0.0.1:$p/\" 2>/dev/null || true)",
    '        if echo "$root" | grep -qE "^(200|30[0-9])"; then return 0; fi',
    '        case " $COMMON " in',
    '          *" $p "*) return 0 ;;',
    "        esac",
    "        return 1",
    "      fi",
    "      return 0",
    "    fi",
    "  done",
    "  return 1",
    "}",
  ];
}

/** Shell script: print first localhost port with a responding product server. */
export function buildDiscoverDevboxPortScript(): string {
  return [
    "set +e",
    ...portProbeHelpers(),
    "LISTEN=''",
    "if command -v ss >/dev/null 2>&1; then",
    "  LISTEN=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -n 's/.*:\\([0-9][0-9]*\\)$/\\1/p' | sort -un | tr '\\n' ' ')",
    "fi",
    // Prefer well-known app ports before arbitrary ss listeners (avoids 8081).
    "for p in $COMMON $LISTEN; do",
    '  if try_port "$p"; then echo "$p"; exit 0; fi',
    "done",
    "exit 1",
  ].join("\n");
}

/** Start a dev server in background for a one-off Playwright snapshot. */
export function buildStartDevServerForSnapshotScript(): string {
  return [
    "set +e",
    "mkdir -p /workspace/.home 2>/dev/null || true",
    "PIDFILE=/workspace/.home/devin-snapshot-server.pid",
    "LOG=/workspace/.home/devin-snapshot-server.log",
    "BIN=/workspace/.home/devin-app",
    'if [ -f "$PIDFILE" ]; then',
    '  old=$(cat "$PIDFILE" 2>/dev/null || true)',
    '  if [ -n "$old" ]; then kill -- -$old 2>/dev/null || kill "$old" 2>/dev/null || true; fi',
    '  rm -f "$PIDFILE"',
    "fi",
    'CMD=""',
    // Prefer Go when go.mod/main.go exist — greenfield agents often leave a Node
    // package.json scaffold whose npm start would otherwise win and blank Desktop.
    "if [ -f go.mod ] || [ -f main.go ]; then",
    "  if command -v go >/dev/null 2>&1; then",
    '    if [ -x "$BIN" ]; then CMD="$BIN";',
    '    else CMD="go build -o $BIN . && exec $BIN"; fi',
    "  fi",
    "fi",
    'if [ -z "$CMD" ] && [ -f package.json ]; then',
    '  if [ -d .next ] && grep -q \'"start"\' package.json 2>/dev/null; then CMD="npm start"',
    '  elif grep -q \'"dev"\' package.json 2>/dev/null; then CMD="npm run dev"',
    '  elif grep -q \'"start"\' package.json 2>/dev/null; then CMD="npm start"; fi',
    "fi",
    'if [ -z "$CMD" ] && [ -f package.json ]; then',
    '  if [ -f dist/index.js ]; then CMD="node dist/index.js"',
    '  elif [ -f dist/server.js ]; then CMD="node dist/server.js"',
    '  elif [ -f server.js ]; then CMD="node server.js"',
    '  elif [ -f index.js ]; then CMD="node index.js"',
    '  elif command -v npx >/dev/null 2>&1 && [ -f src/index.ts ]; then CMD="npx --yes tsx src/index.ts"',
    '  elif command -v npx >/dev/null 2>&1 && [ -f src/server.ts ]; then CMD="npx --yes tsx src/server.ts"',
    '  elif command -v npx >/dev/null 2>&1 && [ -f server.ts ]; then CMD="npx --yes tsx server.ts"',
    '  elif command -v npx >/dev/null 2>&1 && [ -f index.ts ]; then CMD="npx --yes tsx index.ts"; fi',
    "fi",
    'if [ -z "$CMD" ]; then',
    "  if [ -f main.py ] && grep -qE 'FastAPI|fastapi' main.py 2>/dev/null; then",
    '    CMD="python3 -m uvicorn main:app --host 127.0.0.1 --port 8000"',
    "  elif [ -f app.py ] && grep -qE 'FastAPI|fastapi|Flask|flask' app.py 2>/dev/null; then",
    '    if grep -qE "FastAPI|fastapi" app.py 2>/dev/null; then CMD="python3 -m uvicorn app:app --host 127.0.0.1 --port 8000";',
    '    else CMD="python3 -m flask --app app run --host 127.0.0.1 --port 5000"; fi',
    "  elif [ -f manage.py ]; then",
    '    CMD="python3 manage.py runserver 127.0.0.1:8000"',
    "  elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then",
    '    if [ -f main.py ]; then CMD="python3 -m uvicorn main:app --host 127.0.0.1 --port 8000";',
    '    elif [ -f app.py ]; then CMD="python3 -m uvicorn app:app --host 127.0.0.1 --port 8000"; fi',
    "  fi",
    "fi",
    'if [ -z "$CMD" ] && [ -f Cargo.toml ]; then',
    '  if command -v cargo >/dev/null 2>&1; then CMD="cargo run --release"; fi',
    "fi",
    'if [ -z "$CMD" ]; then echo "no snapshot start command" >>"$LOG"; exit 0; fi',
    "export HOST=127.0.0.1 PORT=3000 HOSTNAME=127.0.0.1",
    'export PATH="/usr/local/go/bin:/usr/local/bin:/root/.local/bin:$PATH"',
    // New process group so stop can kill the whole tree (go build + server).
    'nohup bash -lc "set -m; $CMD" >>"$LOG" 2>&1 &',
    'echo $! > "$PIDFILE"',
    'echo "started: $CMD" >>"$LOG"',
  ].join("\n");
}

export function buildStopDevServerForSnapshotScript(): string {
  return [
    "set +e",
    "PIDFILE=/workspace/.home/devin-snapshot-server.pid",
    'if [ -f "$PIDFILE" ]; then',
    '  old=$(cat "$PIDFILE" 2>/dev/null || true)',
    '  if [ -n "$old" ]; then kill -- -$old 2>/dev/null || kill "$old" 2>/dev/null || true; fi',
    '  rm -f "$PIDFILE"',
    "fi",
  ].join("\n");
}

export function buildWaitForDevServerScript(): string {
  return [
    "set +e",
    ...portProbeHelpers(),
    // Cold go build + listen often exceeds 30s.
    "for i in $(seq 1 90); do",
    "  LISTEN=''",
    "  if command -v ss >/dev/null 2>&1; then",
    "    LISTEN=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -n 's/.*:\\([0-9][0-9]*\\)$/\\1/p' | sort -un | tr '\\n' ' ')",
    "  fi",
    "  for p in $COMMON $LISTEN; do",
    '    if try_port "$p"; then echo "$p"; exit 0; fi',
    "  done",
    "  sleep 1",
    "done",
    "exit 1",
  ].join("\n");
}

/** Playwright + Chromium fallback screenshot script for scheduler terminal path. */
export function buildDesktopScreenshotScript(
  url: string,
  outputPath: string,
): string {
  const safeUrl = url.replace(/'/g, `'\"'\"'`);
  const safeOut = outputPath.replace(/'/g, `'\"'\"'`);
  return [
    "set +e",
    "mkdir -p /workspace/.home 2>/dev/null || true",
    "SCRIPT=/workspace/.home/desktop-screenshot.mjs",
    "cat > \"$SCRIPT\" <<'EOS'",
    "import { chromium } from 'playwright-core';",
    "const url = process.env.SHOT_URL;",
    "const out = process.env.SHOT_OUT;",
    "const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';",
    "const browser = await chromium.launch({",
    "  headless: true,",
    "  executablePath,",
    "  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],",
    "});",
    "const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });",
    "await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });",
    "await page.waitForTimeout(1200);",
    "await page.screenshot({ path: out, fullPage: false, type: 'png' });",
    "await browser.close();",
    "EOS",
    `export SHOT_URL='${safeUrl}'`,
    `export SHOT_OUT='${safeOut}'`,
    "export NODE_PATH=/usr/local/lib/node_modules",
    "export CHROMIUM_PATH=/usr/bin/chromium",
    "if command -v chromium >/dev/null 2>&1; then B=chromium; elif command -v chromium-browser >/dev/null 2>&1; then B=chromium-browser; else B=; fi",
    'if [ -n "$B" ]; then',
    `"$B" --headless --disable-gpu --no-sandbox --disable-dev-shm-usage --window-size=1024,768 --hide-scrollbars --run-all-compositor-stages-before-draw --virtual-time-budget=10000 --screenshot='${safeOut}' '${safeUrl}' && exit 0`,
    "fi",
    'node "$SCRIPT"',
  ].join("\n");
}

/** Prune build/package caches when workspace tmpfs is tight. */
export function buildPruneWorkspaceDiskScript(): string {
  return [
    "set +e",
    // Grow golden-snapshot tmpfs (4G) without rebuilding Firecracker images.
    "mount -o remount,size=8G /workspace 2>/dev/null || true",
    "mkdir -p /workspace/.build/npm-cache /workspace/.build/xdg-cache /workspace/.build/cargo-home /workspace/.build/target 2>/dev/null || true",
    "df_line=$(df -P /workspace 2>/dev/null | tail -1)",
    'pct=$(echo "$df_line" | awk "{print $5}" | tr -d "%")',
    'if [ -n "$pct" ] && [ "$pct" -ge 80 ]; then',
    "  rm -rf /workspace/.build/target /workspace/.build/cargo-home/registry/cache",
    "  rm -rf /workspace/.build/npm-cache /workspace/.build/xdg-cache /workspace/.build/pip-cache",
    "  rm -rf /workspace/repo/target /workspace/repo/node_modules/.cache /workspace/repo/.next/cache",
    "  rm -rf /workspace/.home/.cargo/registry/cache 2>/dev/null",
    "  rm -rf /workspace/.home/.cache/pip /workspace/.home/.npm/_cacache 2>/dev/null",
    "  rm -rf /workspace/.home/.cursor/logs 2>/dev/null",
    "  find /workspace/repo -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true",
    "fi",
  ].join("\n");
}
