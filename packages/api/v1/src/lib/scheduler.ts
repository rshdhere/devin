import { resolveSchedulerBaseUrl } from "./scheduler-url.js";

const schedulerBaseUrl = () => resolveSchedulerBaseUrl();

const schedulerFetchTimeoutMs = () => {
  const raw = Number.parseInt(
    process.env.SCHEDULER_FETCH_TIMEOUT_MS ?? "25000",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
};

async function proxyScheduler(
  path: string,
  init?: RequestInit,
  options?: { timeoutMs?: number | null },
): Promise<Response> {
  const url = `${schedulerBaseUrl()}${path}`;

  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  const hasBody = init?.body !== undefined && init?.body !== null;
  if (hasBody && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  const timeoutMs =
    options?.timeoutMs === null
      ? undefined
      : (options?.timeoutMs ?? schedulerFetchTimeoutMs());
  const signal =
    init?.signal ??
    (timeoutMs !== undefined && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined);

  try {
    return await fetch(url, {
      ...init,
      headers,
      signal,
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Scheduler request failed";
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        `Scheduler timed out after ${timeoutMs}ms at ${schedulerBaseUrl()}`,
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Scheduler request aborted or timed out at ${schedulerBaseUrl()}`,
      );
    }
    throw new Error(
      `Scheduler unavailable at ${schedulerBaseUrl()}: ${detail}`,
    );
  }
}

export async function listTasks(): Promise<Response> {
  return proxyScheduler("/api/v1/tasks");
}

export async function createTask(body: unknown): Promise<Response> {
  return proxyScheduler("/api/v1/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getTask(id: string): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}`);
}

export async function streamTaskEvents(id: string): Promise<Response> {
  return proxyScheduler(
    `/api/v1/tasks/${encodeURIComponent(id)}/events`,
    undefined,
    { timeoutMs: null },
  );
}

export async function getInfraDiagnostics(): Promise<Response> {
  return proxyScheduler("/api/v1/diagnostics");
}

export async function getTaskDiagnostics(id: string): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/diagnostics`);
}

export async function startTaskExecution(id: string): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/execute`, {
    method: "POST",
  });
}

export async function retryTask(id: string): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });
}

export async function commitTaskWork(id: string): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/commit`, {
    method: "POST",
  });
}

export async function raiseTaskPullRequest(id: string): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/pr`, {
    method: "POST",
  });
}

export async function continueTask(
  id: string,
  prompt: string,
  agentModel?: string,
): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/continue`, {
    method: "POST",
    body: JSON.stringify({ prompt, agentModel }),
  });
}

export async function terminateSession(id: string): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/terminate`, {
    method: "POST",
  });
}

export async function wakeSession(id: string): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/wake`, {
    method: "POST",
  });
}

export async function runTaskTerminal(
  id: string,
  body: { command: string; cwd?: string; stream?: boolean },
): Promise<Response> {
  return proxyScheduler(
    `/api/v1/tasks/${encodeURIComponent(id)}/terminal`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    body.stream ? { timeoutMs: null } : undefined,
  );
}

export async function listTaskFiles(id: string, path = "."): Promise<Response> {
  return proxyScheduler(
    `/api/v1/tasks/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`,
  );
}

export async function readTaskFile(
  id: string,
  path: string,
): Promise<Response> {
  return proxyScheduler(
    `/api/v1/tasks/${encodeURIComponent(id)}/files/read?path=${encodeURIComponent(path)}`,
  );
}

export async function fetchTaskEventHistory(id: string): Promise<Response> {
  return proxyScheduler(
    `/api/v1/tasks/${encodeURIComponent(id)}/events/history`,
  );
}

export async function fetchDevboxPreview(
  id: string,
  path = "/",
  opts?: { warm?: boolean },
): Promise<Response> {
  const warmQuery = opts?.warm ? "&warm=1" : "";
  return proxyScheduler(
    `/api/v1/tasks/${encodeURIComponent(id)}/devbox-preview?path=${encodeURIComponent(path)}${warmQuery}`,
    {
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "identity",
      },
    },
    { timeoutMs: null },
  );
}

export async function fetchDesktopScreenshot(
  id: string,
  opts?: { fresh?: boolean },
): Promise<Response> {
  const freshQuery = opts?.fresh ? "?fresh=1" : "";
  return proxyScheduler(
    `/api/v1/tasks/${encodeURIComponent(id)}/desktop-screenshot${freshQuery}`,
    undefined,
    { timeoutMs: null },
  );
}

export async function fetchDesktopVNC(id: string): Promise<Response> {
  // Wake/rehydrate can exceed the default scheduler timeout (same as preview/screenshot).
  return proxyScheduler(
    `/api/v1/tasks/${encodeURIComponent(id)}/desktop-vnc`,
    undefined,
    { timeoutMs: null },
  );
}

export { schedulerBaseUrl };
