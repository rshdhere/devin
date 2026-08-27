import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";
import { resolveRuntimeSession } from "./resolve-session-proxy.js";
import { emit } from "./task-state.js";

function normalizePreviewPath(path?: string): string {
  if (!path || typeof path !== "string") {
    return "/";
  }
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) {
    return `/${trimmed}`;
  }
  return trimmed || "/";
}

export async function navigateDesktopBrowserToPort(
  svc: TaskService,
  session: ReviewSession,
  taskId: string,
  port: number,
  previewPath = "/",
): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  const path = normalizePreviewPath(previewPath);
  const url = `http://127.0.0.1:${port}${path === "/" ? "/" : path}`;
  let lastDetail = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(
        `${session.runtimeBaseUrl}/desktop/navigate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(35_000),
        },
      );
      if (response.ok) {
        emit(
          svc,
          "agent.log",
          taskId,
          "Desktop browser navigated to app preview",
          {
            port,
            path,
            url,
            desktop: true,
            attempt: attempt + 1,
          },
        );
        return true;
      }
      lastDetail = `HTTP ${response.status}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  emit(svc, "agent.log", taskId, "Desktop browser navigate failed", {
    port,
    path,
    url,
    detail: lastDetail,
    desktop: true,
  });
  return false;
}

export async function navigateDesktopBrowserForTask(
  svc: TaskService,
  taskId: string,
  port: number,
  previewPath = "/",
): Promise<boolean> {
  const session = await resolveRuntimeSession(svc, taskId);
  if (!session) {
    return false;
  }
  return navigateDesktopBrowserToPort(svc, session, taskId, port, previewPath);
}
