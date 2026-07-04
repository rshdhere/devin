const schedulerBaseUrl = () =>
  (process.env.SCHEDULER_URL ?? "http://localhost:9091").replace(/\/$/, "");

async function proxyScheduler(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${schedulerBaseUrl()}${path}`;

  try {
    return await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Scheduler request failed";
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
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/events`);
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
): Promise<Response> {
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/continue`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
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
  return proxyScheduler(`/api/v1/tasks/${encodeURIComponent(id)}/terminal`, {
    method: "POST",
    body: JSON.stringify(body),
  });
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

export { schedulerBaseUrl };
