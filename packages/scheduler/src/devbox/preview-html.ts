/** Prefix for task-scoped devbox preview asset paths (root-relative URLs). */
export function devboxPreviewPathPrefix(taskId: string): string {
  return `/api/v1/tasks/${encodeURIComponent(taskId)}/devbox-preview?path=`;
}

function toPreviewPath(taskId: string, assetPath: string): string {
  const normalized = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
  return `${devboxPreviewPathPrefix(taskId)}${encodeURIComponent(normalized)}`;
}

/**
 * Rewrite root-relative asset URLs so iframe sub-resources load through the
 * devbox-preview proxy instead of the API host (fixes unstyled Next.js Live view).
 */
export function rewriteDevboxPreviewHtml(html: string, taskId: string): string {
  const prefix = devboxPreviewPathPrefix(taskId);
  let out = html.replace(
    /(\s(?:href|src|action)=["'])\/(?!\/)([^"']*)/gi,
    (_, lead, path) => `${lead}${toPreviewPath(taskId, `/${path}`)}`,
  );
  out = out.replace(
    /(\scontent=["'])\/(?!\/)([^"']*)/gi,
    (_, lead, path) => `${lead}${toPreviewPath(taskId, `/${path}`)}`,
  );
  // Inline styles: url(/_next/static/...)
  out = out.replace(
    /url\(\s*(['"]?)\/(?!\/)([^'")]*)/gi,
    (_, quote, path) => `url(${quote}${toPreviewPath(taskId, `/${path}`)}`,
  );
  return out;
}

/** Rewrite root-relative url(...) references in proxied stylesheets. */
export function rewriteDevboxPreviewCss(css: string, taskId: string): string {
  return css.replace(
    /url\(\s*(['"]?)\/(?!\/)([^'")]*)/gi,
    (_, quote, path) => `url(${quote}${toPreviewPath(taskId, `/${path}`)}`,
  );
}

export function maybeRewriteDevboxPreviewBody(
  taskId: string,
  contentType: string,
  body: Buffer,
): Buffer {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/html")) {
    return Buffer.from(rewriteDevboxPreviewHtml(body.toString("utf8"), taskId));
  }
  if (lower.includes("text/css")) {
    return Buffer.from(rewriteDevboxPreviewCss(body.toString("utf8"), taskId));
  }
  return body;
}
