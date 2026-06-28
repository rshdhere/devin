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

export { schedulerBaseUrl };
