/** Shell script: print first localhost port that responds with HTTP 2xx/3xx. */
export function buildDiscoverDevboxPortScript(): string {
  return [
    "set +e",
    "for p in 3000 5173 8080 8000 4173; do",
    "  code=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:$p/ 2>/dev/null || true)",
    '  if echo "$code" | grep -qE "^(200|30[0-9])"; then echo "$p"; exit 0; fi',
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
