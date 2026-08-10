/** Shell script: print first localhost port with a responding dev server (HTTP 2xx/3xx). */
export function buildDiscoverDevboxPortScript(): string {
  return [
    "set +e",
    "COMMON='3000 5173 8080 8000 5000 4173 3001 4200 9000 1313 4321 24678'",
    "LISTEN=''",
    "if command -v ss >/dev/null 2>&1; then",
    "  for p in $COMMON; do",
    '    if ss -ltn 2>/dev/null | grep -qE ":$p[[:space:]]"; then LISTEN="$LISTEN $p"; fi',
    "  done",
    "fi",
    "try_port() {",
    "  p=$1",
    "  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept-Encoding: identity' --max-time 3 \"http://127.0.0.1:$p/\" 2>/dev/null || true)",
    '  echo "$code" | grep -qE "^(200|30[0-9])"',
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

/** Headless Chromium screenshot of a guest localhost URL (agent/rust images). */
export function buildDesktopScreenshotScript(
  url: string,
  outputPath: string,
): string {
  const safeUrl = url.replace(/'/g, `'\"'\"'`);
  const safeOut = outputPath.replace(/'/g, `'\"'\"'`);
  return [
    "set -e",
    "if command -v chromium >/dev/null 2>&1; then B=chromium; elif command -v chromium-browser >/dev/null 2>&1; then B=chromium-browser; else exit 127; fi",
    `"$B" --headless --disable-gpu --no-sandbox --window-size=1280,720 --screenshot='${safeOut}' '${safeUrl}'`,
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
