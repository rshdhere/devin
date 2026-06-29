import { createServer } from "node:http";
import { formatSSE, TaskService } from "@devin/scheduler";

const port = Number(process.env.SCHEDULER_PORT ?? 9091);
const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:9090";
const runtimeUrl = process.env.RUNTIME_URL ?? "http://localhost:8081";
const firecrackerHostUrl =
  process.env.FIRECRACKER_HOST_URL?.trim() || undefined;
const queueDriver = process.env.QUEUE_DRIVER ?? "memory";
const defaultAgent = process.env.DEFAULT_AGENT as
  | "cursor"
  | "claude"
  | "mock"
  | undefined;
const preferredHost = process.env.SCHEDULER_HOST_NAME?.trim() || undefined;

const tasks = new TaskService({
  orchestratorUrl,
  runtimeUrl,
  firecrackerHostUrl,
  preferredHost,
  defaultAgent,
});

tasks.startWorker();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/diagnostics") {
    try {
      const diagnostics = await tasks.getInfraDiagnostics();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(diagnostics));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "diagnostics failed",
        }),
      );
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/tasks") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(tasks.listTasks()));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/tasks") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body) as {
        prompt?: string;
        agent?: "cursor" | "claude" | "mock";
        userId?: string;
        repository?: string;
        cloneUrl?: string;
        githubToken?: string;
        permissions?: {
          canCommit: boolean;
          canCreatePr: boolean;
          canPush: boolean;
        };
      };
      const task = tasks.createTask({
        prompt: parsed.prompt ?? "",
        agent: parsed.agent,
        userId: parsed.userId,
        repository: parsed.repository,
        cloneUrl: parsed.cloneUrl,
        githubToken: parsed.githubToken,
        permissions: parsed.permissions,
      });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "invalid request",
        }),
      );
    }
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const taskId = taskMatch[1]!;
    const task = tasks.getTask(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "task not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
    return;
  }

  const diagnosticsMatch = url.pathname.match(
    /^\/api\/v1\/tasks\/([^/]+)\/diagnostics$/,
  );
  if (req.method === "GET" && diagnosticsMatch) {
    const taskId = diagnosticsMatch[1]!;
    const task = tasks.getTask(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "task not found" }));
      return;
    }

    try {
      const diagnostics = await tasks.getTaskDiagnostics(taskId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(diagnostics));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "diagnostics failed",
        }),
      );
    }
    return;
  }

  const eventsMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const taskId = eventsMatch[1]!;
    const task = tasks.getTask(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "task not found" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    for (const event of tasks.getEventBus().historyFor(taskId)) {
      res.write(formatSSE(event));
    }

    const unsubscribe = tasks.getEventBus().subscribe(taskId, (event) => {
      res.write(formatSSE(event));
    });

    req.on("close", () => {
      unsubscribe();
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    `scheduler listening @ http://0.0.0.0:${port} (queue=${queueDriver})`,
  );
});

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
