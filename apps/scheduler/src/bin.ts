import { createServer } from "node:http";
import {
  fetchFirecrackerHostStatus,
  formatSSE,
  handlePreviewProxy,
  shouldHandlePreviewHost,
  TaskService,
} from "@devin/scheduler";

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

async function resolvePreferredHost(): Promise<string | undefined> {
  const explicit = process.env.SCHEDULER_HOST_NAME?.trim();
  if (explicit) {
    return explicit;
  }
  if (!firecrackerHostUrl) {
    return undefined;
  }
  const status = await fetchFirecrackerHostStatus(firecrackerHostUrl);
  return status?.host?.trim() || undefined;
}

async function main(): Promise<void> {
  const preferredHost = await resolvePreferredHost();
  if (preferredHost) {
    console.log(`scheduler pinned to execution host ${preferredHost}`);
  }

  const tasks = new TaskService({
    orchestratorUrl,
    runtimeUrl,
    firecrackerHostUrl,
    preferredHost,
    defaultAgent,
  });

  tasks.startWorker();

  const server = createServer(async (req, res) => {
    if (shouldHandlePreviewHost(req.headers.host)) {
      handlePreviewProxy(req, res);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", preferredHost }));
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
            error:
              error instanceof Error ? error.message : "diagnostics failed",
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
            canCreateRepo: boolean;
            canCreateIssue: boolean;
            canPush: boolean;
          };
          createRepository?: string;
          autoCreateRepository?: boolean;
          autoStartSandbox?: boolean;
          testCommand?: string;
          issueTitle?: string;
          issueBody?: string;
        };
        const task = tasks.createTask({
          prompt: parsed.prompt ?? "",
          agent: parsed.agent,
          userId: parsed.userId,
          repository: parsed.repository,
          createRepository: parsed.createRepository,
          autoCreateRepository: parsed.autoCreateRepository,
          autoStartSandbox: parsed.autoStartSandbox,
          cloneUrl: parsed.cloneUrl,
          githubToken: parsed.githubToken,
          permissions: parsed.permissions,
          testCommand: parsed.testCommand,
          issueTitle: parsed.issueTitle,
          issueBody: parsed.issueBody,
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
            error:
              error instanceof Error ? error.message : "diagnostics failed",
          }),
        );
      }
      return;
    }

    const eventsMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/events$/,
    );
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

      const keepalive = setInterval(() => {
        res.write(": keepalive\n\n");
      }, 15_000);

      req.on("close", () => {
        clearInterval(keepalive);
        unsubscribe();
      });
      return;
    }

    const executeMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/execute$/,
    );
    if (req.method === "POST" && executeMatch) {
      const taskId = executeMatch[1]!;
      try {
        const task = await tasks.startExecution(taskId);
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify(task));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "execute failed",
          }),
        );
      }
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
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
