const apiUrl =
  process.env.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:8080";
const webAppUrl =
  process.env.NEXT_PUBLIC_WEB_APP_URL?.trim() || "http://localhost:3000";

export const authConfig = {
  baseURL: apiUrl,
  basePath: "/api/v1/auth",
  webAppUrl,
} as const;

export function getCallbackURL(path = "/dashboard") {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  const origin =
    typeof window !== "undefined" ? window.location.origin : webAppUrl;

  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}
