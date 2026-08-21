/** Keep Interactive Desktop working when guest HTML still uses relative imports. */
export function rewriteDesktopVncPageHtml(
  html: string,
  taskId: string,
): string {
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
