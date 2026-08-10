/** Shell script: print first localhost port with a responding dev server (HTTP 2xx/3xx). */
export function buildDiscoverDevboxPortScript(): string {
  return [
    "set +e",
    "COMMON='8000 3000 5173 8080 5000 4173 3001 4200 9000 1313 4321 24678'",
    "LISTEN=''",
    "if command -v ss >/dev/null 2>&1; then",
    "  for p in $COMMON; do",
    '    if ss -ltn 2>/dev/null | grep -qE ":$p[[:space:]]"; then LISTEN="$LISTEN $p"; fi',
    "  done",
    "fi",
    "try_port() {",
    "  p=$1",
    "  for path in / /health; do",
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

/** Start npm dev/start in background for a one-off Playwright snapshot. */
export function buildStartDevServerForSnapshotScript(): string {
  return [
    "set +e",
    "PIDFILE=/workspace/.home/devin-snapshot-server.pid",
    'if [ -f "$PIDFILE" ]; then kill $(cat "$PIDFILE") 2>/dev/null || true; rm -f "$PIDFILE"; fi',
    "if [ ! -f package.json ]; then exit 0; fi",
    'CMD=""',
    'if grep -q "\\"dev\\"" package.json 2>/dev/null; then CMD="npm run dev"; elif grep -q "\\"start\\"" package.json 2>/dev/null; then CMD="npm start"; fi',
    'if [ -z "$CMD" ]; then exit 0; fi',
    'nohup bash -lc "$CMD" >>/workspace/.home/devin-snapshot-server.log 2>&1 &',
    'echo $! > "$PIDFILE"',
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
    "for i in $(seq 1 45); do",
    "  for p in 3000 8000 5173 8080; do",
    "    code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: identity' --max-time 2 \"http://127.0.0.1:$p/\" 2>/dev/null || true)",
    '    if echo "$code" | grep -qE "^(200|30[0-9])"; then echo "$p"; exit 0; fi',
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
    "const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });",
    "await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });",
    "await page.waitForTimeout(1500);",
    "await page.screenshot({ path: out, fullPage: false, type: 'png' });",
    "await browser.close();",
    "EOS",
    `export SHOT_URL='${safeUrl}'`,
    `export SHOT_OUT='${safeOut}'`,
    "export NODE_PATH=/usr/local/lib/node_modules",
    "export CHROMIUM_PATH=/usr/bin/chromium",
    'if node "$SCRIPT"; then exit 0; fi',
    "if command -v chromium >/dev/null 2>&1; then B=chromium; elif command -v chromium-browser >/dev/null 2>&1; then B=chromium-browser; else exit 127; fi",
    `"$B" --headless --disable-gpu --no-sandbox --window-size=1280,720 --hide-scrollbars --run-all-compositor-stages-before-draw --virtual-time-budget=8000 --screenshot='${safeOut}' '${safeUrl}'`,
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
