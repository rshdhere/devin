import type { IncomingHttpHeaders } from "node:http";

/** Strip compression headers so piped bodies match what browsers decode. */
export function sanitizeProxyResponseHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    if (
      lower === "content-encoding" ||
      lower === "content-length" ||
      lower === "transfer-encoding"
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function devboxUpstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  host: string,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "accept-encoding"
    ) {
      continue;
    }
    headers[key] = value;
  }
  headers.host = host;
  headers["accept-encoding"] = "identity";
  return headers;
}
