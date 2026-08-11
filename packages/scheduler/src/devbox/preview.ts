/** Well-known dev server ports probed when no listener is discovered dynamically. */
export const COMMON_DEVBOX_PORTS = [
  8000, 3000, 5173, 8080, 5000, 4173, 3001, 3002, 4200, 9000, 8888, 1313, 4321,
  24678,
] as const;

function commonPortsShellList(): string {
  return COMMON_DEVBOX_PORTS.join(" ");
}

/** Shell script: print first localhost port with a responding dev server (HTTP 2xx/3xx). */
export function buildDiscoverDevboxPortScript(): string {
  return [
    "set +e",
    `COMMON='${commonPortsShellList()}'`,
    "LISTEN=''",
    "if command -v ss >/dev/null 2>&1; then",
    "  LISTEN=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -n 's/.*:\\([0-9][0-9]*\\)$/\\1/p' | sort -un | tr '\\n' ' ')",
    "fi",
    "try_port() {",
    "  p=$1",
    "  for path in / /health /api/health; do",
    "    code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: identity' --max-time 3 \"http://127.0.0.1:$p$path\" 2>/dev/null || true)",
    '    if echo "$code" | grep -qE "^(200|30[0-9])"; then return 0; fi',
    "  done",
    "  return 1",
    "}",
    "for p in $LISTEN $COMMON; do",
    '  if try_port "$p"; then echo "$p"; exit 0; fi',
    "done",
    "for p in $LISTEN $COMMON; do",
    '  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ":$p[[:space:]]"; then echo "$p"; exit 0; fi',
    "done",
    "exit 1",
  ].join("\n");
}

/** Start a dev server in background for a one-off Playwright snapshot. */
export function buildStartDevServerForSnapshotScript(): string {
  return [
    "set +e",
    "PIDFILE=/workspace/.home/devin-snapshot-server.pid",
    "LOG=/workspace/.home/devin-snapshot-server.log",
    'if [ -f "$PIDFILE" ]; then kill $(cat "$PIDFILE") 2>/dev/null || true; rm -f "$PIDFILE"; fi',
    'CMD=""',
    "if [ -f package.json ]; then",
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
    // Prefer Go when go.mod/main.go exist — greenfield agents often leave a Node
    // package.json scaffold whose npm start would otherwise win and blank Desktop.
    "if [ -f go.mod ] || [ -f main.go ]; then",
    '  if command -v go >/dev/null 2>&1; then CMD="go run ."; fi',
    "fi",
    'if [ -z "$CMD" ]; then echo "no snapshot start command" >>"$LOG"; exit 0; fi',
    "export HOST=127.0.0.1 PORT=3000 HOSTNAME=127.0.0.1",
    'nohup bash -lc "$CMD" >>"$LOG" 2>&1 &',
    'echo $! > "$PIDFILE"',
    'echo "started: $CMD" >>"$LOG"',
  ].join("\n");
}

export function buildStopDevServerForSnapshotScript(): string {
  return [
    "set +e",
    "PIDFILE=/workspace/.home/devin-snapshot-server.pid",
    'if [ -f "$PIDFILE" ]; then kill $(cat "$PIDFILE") 2>/dev/null || true; rm -f "$PIDFILE"; fi',
  ].join("\n");
}

export function buildWaitForDevServerScript(): string {
  return [
    "set +e",
    `COMMON='${commonPortsShellList()}'`,
    "try_port() {",
    "  p=$1",
    "  for path in / /health /api/health; do",
    "    code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: identity' --max-time 2 \"http://127.0.0.1:$p$path\" 2>/dev/null || true)",
    '    if echo "$code" | grep -qE "^(200|30[0-9])"; then echo "$p"; exit 0; fi',
    "  done",
    "  return 1",
    "}",
    "for i in $(seq 1 30); do",
    "  LISTEN=''",
    "  if command -v ss >/dev/null 2>&1; then",
    "    LISTEN=$(ss -ltnH 2>/dev/null | awk '{print $4}' | sed -n 's/.*:\\([0-9][0-9]*\\)$/\\1/p' | sort -un | tr '\\n' ' ')",
    "  fi",
    "  for p in $LISTEN $COMMON; do",
    '    if try_port "$p"; then exit 0; fi',
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
    `"$B" --headless --disable-gpu --no-sandbox --window-size=1024,768 --hide-scrollbars --run-all-compositor-stages-before-draw --virtual-time-budget=10000 --screenshot='${safeOut}' '${safeUrl}' && exit 0`,
    "fi",
    'node "$SCRIPT"',
  ].join("\n");
}

/** Prune cargo/target dirs when workspace tmpfs is tight. */
export function buildPruneWorkspaceDiskScript(): string {
  return [
    "set +e",
    "df_line=$(df -P /workspace 2>/dev/null | tail -1)",
    'pct=$(echo "$df_line" | awk "{print $5}" | tr -d "%")',
    'if [ -n "$pct" ] && [ "$pct" -ge 88 ]; then',
    "  rm -rf /workspace/.build/target /workspace/.build/cargo-home/registry/cache",
    "  rm -rf /workspace/repo/target",
    "  rm -rf /workspace/.home/.cargo/registry/cache 2>/dev/null",
    "fi",
  ].join("\n");
}
