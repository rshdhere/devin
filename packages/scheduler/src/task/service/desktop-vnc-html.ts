/**
 * noVNC HTML is generated inside the guest runtime. Older snapshots still emit
 * relative imports that resolve `.../desktop-vnc` → `.../assets/core/rfb.js`
 * (dropping `desktop-vnc`), which the API serves as HTML and the browser
 * blocks as a bad MIME type. Rewrite the page at the proxy edge so Interactive
 * Desktop works even before guest images are rebuilt.
 */
export function rewriteDesktopVncHtml(html: string, taskId: string): string {
  const desktopPath = `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop-vnc`;
  const assetModule = `${desktopPath}/assets/core/rfb.js`;
  const wsPath = `${desktopPath}/ws`;

  const script = `<script type="module">
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const url = proto + '//' + location.host + ${JSON.stringify(wsPath)};
import(${JSON.stringify(assetModule)}).then(({ default: RFB }) => {
  const rfb = new RFB(document.getElementById('screen'), url, { scaleViewport: true, resizeSession: false });
  rfb.viewOnly = false;
  rfb.focusOnClick = true;
  rfb.clipViewport = false;
  rfb.scaleViewport = true;
}).catch((err) => {
  document.body.innerHTML = '<pre style="color:#f88;padding:16px;font:12px monospace">Failed to load noVNC: ' + String(err) + '</pre>';
});
</script>`;

  if (/<script type="module">[\s\S]*?<\/script>/i.test(html)) {
    return html.replace(/<script type="module">[\s\S]*?<\/script>/i, script);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}

export function contentTypeForVncAsset(assetPath: string): string | undefined {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (lower.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (lower.endsWith(".map")) {
    return "application/json";
  }
  return undefined;
}
