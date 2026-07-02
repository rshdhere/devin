import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getPreviewRoute, matchPreviewSlug } from "./preview-registry.js";

export function shouldHandlePreviewHost(
  hostHeader: string | undefined,
): boolean {
  if (!hostHeader) {
    return false;
  }
  const host = hostHeader.split(":")[0]?.toLowerCase() ?? "";
  return matchPreviewSlug(host) !== null;
}

export function handlePreviewProxy(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const host = req.headers.host?.split(":")[0]?.toLowerCase() ?? "";
  const slug = matchPreviewSlug(host);
  if (!slug) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Preview not found");
    return;
  }

  const route = getPreviewRoute(slug);
  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Preview expired or not registered");
    return;
  }

  const path = req.url ?? "/";
  const proxyReq = http.request(
    {
      hostname: route.upstreamHost,
      port: route.upstreamPort,
      path,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${route.upstreamHost}:${route.upstreamPort}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end(
      `Preview app unavailable: ${error instanceof Error ? error.message : "proxy error"}`,
    );
  });

  req.pipe(proxyReq);
}
