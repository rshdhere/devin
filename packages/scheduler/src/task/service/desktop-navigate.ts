import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";
import { resolveRuntimeSession } from "./resolve-session-proxy.js";

export async function navigateDesktopBrowserToPort(
  svc: TaskService,
  session: ReviewSession,
  _taskId: string,
  port: number,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  try {
    const response = await fetch(`${session.runtimeBaseUrl}/desktop/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) {
      return;
    }
  } catch {
    // best-effort — recording/screenshot may still use headless capture
  }
}

export async function navigateDesktopBrowserForTask(
  svc: TaskService,
  taskId: string,
  port: number,
): Promise<void> {
  const session = await resolveRuntimeSession(svc, taskId);
  if (!session) {
    return;
  }
  await navigateDesktopBrowserToPort(svc, session, taskId, port);
}
