import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";
import { captureDesktopScreenshotWithDevServer } from "./desktop-capture-render.js";
import { navigateDesktopBrowserForTask } from "./desktop-navigate.js";
import { patchTask } from "./task-state.js";

export function maybeTriggerDesktopSnapshotFromRuntime(
  svc: TaskService,
  taskId: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const task = svc.tasks.get(taskId);
  if (task?.status !== "completed" || task.pushedToGitHub !== true) {
    return;
  }
  const detail = typeof data?.detail === "string" ? data.detail : "";
  const text = `${message}\n${detail}`.trim();
  if (!text) {
    return;
  }
  maybeRememberPreviewPortFromText(svc, taskId, text);
  const lower = text.toLowerCase();
  const looksLikeDevServer =
    /compiled successfully|✓ compiled|ready in \d|ready on|local:\s*https?:\/\/|started server|listening on|http:\/\/127\.0\.0\.1:\d+|uvicorn running on|application startup complete|started reloader process|watchfiles\.main/i.test(
      text,
    );
  const looksLikeBuildOk =
    /npm run build|bun run build|next build/i.test(text) &&
    /exit code 0|exited with 0|successfully compiled|compiled successfully|✓|creating an optimized production build/i.test(
      lower,
    );
  if (!looksLikeDevServer && !looksLikeBuildOk) {
    return;
  }
  void triggerDesktopSnapshot(svc, taskId);
}

export function maybeRememberPreviewPortFromText(
  svc: TaskService,
  taskId: string,
  text: string,
): void {
  const match =
    text.match(
      /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{2,5})\b/i,
    ) ?? text.match(/\blistening on[^0-9\n]{0,40}(\d{2,5})\b/i);
  if (!match?.[1]) {
    return;
  }
  const port = Number.parseInt(match[1], 10);
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }
  const session =
    svc.activeSessions.get(taskId) ?? svc.reviewSessions.get(taskId);
  if (!session) {
    return;
  }
  if (session.devboxPreviewPort === port) {
    return;
  }
  session.devboxPreviewPort = port;
  void svc.taskStore.setPreviewPort(taskId, port);
  const previewPath = `/api/v1/tasks/${encodeURIComponent(taskId)}/devbox-preview?path=/`;
  svc.patchTask(taskId, { previewUrl: previewPath });
  void navigateDesktopBrowserForTask(svc, taskId, port);
}

export async function triggerDesktopSnapshot(
  svc: TaskService,
  taskId: string,
): Promise<void> {
  const now = Date.now();
  if (now - (svc.lastSnapshotTriggerAt.get(taskId) ?? 0) < 30_000) {
    return;
  }
  svc.lastSnapshotTriggerAt.set(taskId, now);

  const session =
    svc.activeSessions.get(taskId) ?? svc.reviewSessions.get(taskId);
  if (!session) {
    return;
  }
  try {
    await captureDesktopScreenshotWithDevServer(svc, session, taskId, {
      allowSpin: true,
    });
  } catch {
    // best-effort
  }
}
