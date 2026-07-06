import type {
  CreateTaskRequest,
  InfraDiagnostics,
  Task,
  TaskDiagnostics,
  TaskEvent,
} from "@devin/types";
import { parseJsonResponse, tasksApiUrl } from "./http";

export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch(tasksApiUrl(), { credentials: "include" });
  return parseJsonResponse<Task[]>(response);
}

export async function createTask(input: CreateTaskRequest): Promise<Task> {
  const response = await fetch(tasksApiUrl(), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJsonResponse<Task>(response);
}

export async function fetchTask(id: string): Promise<Task> {
  const response = await fetch(tasksApiUrl(`/${encodeURIComponent(id)}`), {
    credentials: "include",
  });
  return parseJsonResponse<Task>(response);
}

export async function executeTask(id: string): Promise<Task> {
  const response = await fetch(
    tasksApiUrl(`/${encodeURIComponent(id)}/execute`),
    { method: "POST", credentials: "include" },
  );
  return parseJsonResponse<Task>(response);
}

export async function retryTask(id: string): Promise<Task> {
  const response = await fetch(
    tasksApiUrl(`/${encodeURIComponent(id)}/retry`),
    {
      method: "POST",
      credentials: "include",
    },
  );
  return parseJsonResponse<Task>(response);
}

export async function commitTaskWork(id: string): Promise<Task> {
  const response = await fetch(
    tasksApiUrl(`/${encodeURIComponent(id)}/commit`),
    { method: "POST", credentials: "include" },
  );
  return parseJsonResponse<Task>(response);
}

export async function raiseTaskPullRequest(id: string): Promise<Task> {
  const response = await fetch(tasksApiUrl(`/${encodeURIComponent(id)}/pr`), {
    method: "POST",
    credentials: "include",
  });
  return parseJsonResponse<Task>(response);
}

export async function continueTask(id: string, prompt: string): Promise<Task> {
  const response = await fetch(
    tasksApiUrl(`/${encodeURIComponent(id)}/continue`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    },
  );
  return parseJsonResponse<Task>(response);
}

export async function terminateSession(id: string): Promise<Task> {
  const response = await fetch(
    tasksApiUrl(`/${encodeURIComponent(id)}/terminate`),
    { method: "POST", credentials: "include" },
  );
  return parseJsonResponse<Task>(response);
}

export async function wakeSession(id: string): Promise<Task> {
  const response = await fetch(tasksApiUrl(`/${encodeURIComponent(id)}/wake`), {
    method: "POST",
    credentials: "include",
  });
  return parseJsonResponse<Task>(response);
}

export async function listTaskFiles(
  id: string,
  path = ".",
): Promise<{
  path: string;
  items: Array<{ name: string; path: string; isDir: boolean; size: number }>;
}> {
  const response = await fetch(
    tasksApiUrl(
      `/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`,
    ),
    { credentials: "include" },
  );
  return parseJsonResponse(response);
}

export async function readTaskFile(
  id: string,
  path: string,
): Promise<{ path: string; content: string }> {
  const response = await fetch(
    tasksApiUrl(
      `/${encodeURIComponent(id)}/files/read?path=${encodeURIComponent(path)}`,
    ),
    { credentials: "include" },
  );
  return parseJsonResponse(response);
}

export async function runTaskTerminalStream(
  id: string,
  command: string,
  onEvent: (event: {
    type: "terminal.output" | "terminal.done" | "terminal.error";
    data: Record<string, unknown>;
  }) => void,
): Promise<void> {
  const response = await fetch(
    tasksApiUrl(`/${encodeURIComponent(id)}/terminal`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, stream: true }),
    },
  );

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.error === "string" ? body.error : "Terminal request failed",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex >= 0) {
      const chunk = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const eventLine = chunk
        .split("\n")
        .find((line) => line.startsWith("event: "));
      const dataLine = chunk
        .split("\n")
        .find((line) => line.startsWith("data: "));

      if (eventLine && dataLine) {
        const type = eventLine.slice(7).trim() as
          | "terminal.output"
          | "terminal.done"
          | "terminal.error";
        try {
          const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          onEvent({ type, data });
        } catch {
          // ignore malformed chunks
        }
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }
}

export async function fetchTaskEventHistory(id: string): Promise<TaskEvent[]> {
  const response = await fetch(
    tasksApiUrl(`/${encodeURIComponent(id)}/events/history`),
    { credentials: "include" },
  );
  return parseJsonResponse<TaskEvent[]>(response);
}

export async function fetchInfraDiagnostics(): Promise<InfraDiagnostics> {
  const response = await fetch(tasksApiUrl("/diagnostics/infra"), {
    credentials: "include",
  });
  return parseJsonResponse<InfraDiagnostics>(response);
}

export async function fetchTaskDiagnostics(
  id: string,
): Promise<TaskDiagnostics> {
  const response = await fetch(
    tasksApiUrl(`/${encodeURIComponent(id)}/diagnostics`),
    { credentials: "include" },
  );
  return parseJsonResponse<TaskDiagnostics>(response);
}
