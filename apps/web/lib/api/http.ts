import { authConfig } from "@/lib/auth-config";

export const apiBaseUrl = authConfig.baseURL;

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.error === "string" ? body.error : "Request failed",
    );
  }
  return response.json() as Promise<T>;
}

export function tasksApiUrl(path = ""): string {
  const suffix = path.startsWith("/") ? path : path ? `/${path}` : "";
  return `${apiBaseUrl}/api/v1/tasks${suffix}`;
}
