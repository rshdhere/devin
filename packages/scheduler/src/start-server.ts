import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  formatSSE,
  handlePreviewProxy,
  ensureExecutionHostRegistered,
  resolvePreferredHost,
  shouldHandlePreviewHost,
  TaskService,
  type ScheduleJob,
} from "@devin/scheduler";

export interface StartSchedulerServerOptions {
  port: number;
  orchestratorUrl: string;
  runtimeUrl: string;
  firecrackerHostUrl?: string;
  defaultAgent?: "cursor" | "claude" | "mock";
  mode?: "standalone" | "brain" | "worker";
  executionWorkerUrl?: string;
}

export async function startSchedulerServer(
  options: StartSchedulerServerOptions,
): Promise<void> {
  const preferredHost = resolvePreferredHost();
  if (preferredHost) {
    console.log(`service pinned to execution host ${preferredHost}`);
  }

  const tasks = new TaskService({
    orchestratorUrl: options.orchestratorUrl,
    runtimeUrl: options.runtimeUrl,
    firecrackerHostUrl: options.firecrackerHostUrl,
    preferredHost,
    defaultAgent: options.defaultAgent,
    mode: options.mode,
    executionWorkerUrl: options.executionWorkerUrl,
  });

  await tasks.initialize();

  try {
    await ensureExecutionHostRegistered({
      orchestratorUrl: options.orchestratorUrl,
      hostName: preferredHost,
      firecrackerHostUrl: options.firecrackerHostUrl,
    });
  } catch (error) {
    console.error(
      "firecracker host registration failed:",
      error instanceof Error ? error.message : error,
    );
  }

  if (preferredHost) {
    const registerHost = () => {
      void ensureExecutionHostRegistered({
        orchestratorUrl: options.orchestratorUrl,
        hostName: preferredHost,
        firecrackerHostUrl: options.firecrackerHostUrl,
      }).catch((error) => {
        console.error(
          "firecracker host re-registration failed:",
          error instanceof Error ? error.message : error,
        );
      });
    };
    setInterval(registerHost, 60_000).unref();
  }

  tasks.startWorker();

  const server = createServer(async (req, res) => {
    if (shouldHandlePreviewHost(req.headers.host)) {
      handlePreviewProxy(req, res);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        status: "ok",
        mode: tasks.getMode(),
        preferredHost,
        durable: tasks.getTaskStore().isEnabled(),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/internal/v1/jobs") {
      try {
        const job = JSON.parse(await readBody(req)) as ScheduleJob;
        await tasks.ingestWorkerJob(job);
        json(res, 202, { status: "accepted", taskId: job.taskId });
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "invalid job",
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/diagnostics") {
      try {
        const diagnostics = await tasks.getInfraDiagnostics();
        json(res, 200, diagnostics);
      } catch (error) {
        json(res, 500, {
          error: error instanceof Error ? error.message : "diagnostics failed",
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/tasks") {
      const stored = await tasks.listTasksFromStore();
      const merged = stored.length > 0 ? stored : tasks.listTasks();
      json(res, 200, merged);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/v1/tasks") {
      try {
        const parsed = JSON.parse(await readBody(req)) as {
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
          requireReviewBeforePush?: boolean;
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
          requireReviewBeforePush: parsed.requireReviewBeforePush,
          cloneUrl: parsed.cloneUrl,
          githubToken: parsed.githubToken,
          permissions: parsed.permissions,
          testCommand: parsed.testCommand,
          issueTitle: parsed.issueTitle,
          issueBody: parsed.issueBody,
        });
        json(res, 202, task);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "invalid request",
        });
      }
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (req.method === "GET" && taskMatch) {
      const taskId = taskMatch[1]!;
      const task =
        tasks.getTask(taskId) ?? (await tasks.getTaskStore().getTask(taskId));
      if (!task) {
        json(res, 404, { error: "task not found" });
        return;
      }
      json(res, 200, task);
      return;
    }

    const diagnosticsMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/diagnostics$/,
    );
    if (req.method === "GET" && diagnosticsMatch) {
      const taskId = diagnosticsMatch[1]!;
      const task = tasks.getTask(taskId);
      if (!task) {
        json(res, 404, { error: "task not found" });
        return;
      }
      try {
        const diagnostics = await tasks.getTaskDiagnostics(taskId);
        json(res, 200, diagnostics);
      } catch (error) {
        json(res, 500, {
          error: error instanceof Error ? error.message : "diagnostics failed",
        });
      }
      return;
    }

    const historyMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/events\/history$/,
    );
    if (req.method === "GET" && historyMatch) {
      const taskId = historyMatch[1]!;
      const task = tasks.getTask(taskId);
      if (!task && !(await tasks.getTaskStore().getTask(taskId))) {
        json(res, 404, { error: "task not found" });
        return;
      }
      const history =
        tasks.getEventHistory(taskId).length > 0
          ? tasks.getEventHistory(taskId)
          : await tasks.getTaskStore().loadEvents(taskId);
      json(res, 200, history);
      return;
    }

    const eventsMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/events$/,
    );
    if (req.method === "GET" && eventsMatch) {
      const taskId = eventsMatch[1]!;
      await handleTaskEvents(tasks, taskId, req, res);
      return;
    }

    const retryMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/retry$/);
    if (req.method === "POST" && retryMatch) {
      try {
        const task = await tasks.retryTask(retryMatch[1]!);
        json(res, 202, task);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "retry failed",
        });
      }
      return;
    }

    const executeMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/execute$/,
    );
    if (req.method === "POST" && executeMatch) {
      try {
        const task = await tasks.startExecution(executeMatch[1]!);
        json(res, 202, task);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "execute failed",
        });
      }
      return;
    }

    const commitMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/commit$/,
    );
    if (req.method === "POST" && commitMatch) {
      try {
        const task = await tasks.commitTaskWork(commitMatch[1]!);
        json(res, 200, task);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "commit failed",
        });
      }
      return;
    }

    const prMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/pr$/);
    if (req.method === "POST" && prMatch) {
      try {
        const task = await tasks.raiseTaskPullRequest(prMatch[1]!);
        json(res, 200, task);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "pull request failed",
        });
      }
      return;
    }

    const continueMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/continue$/,
    );
    if (req.method === "POST" && continueMatch) {
      try {
        const body = JSON.parse(await readBody(req)) as { prompt?: string };
        const task = await tasks.continueTask(
          continueMatch[1]!,
          body.prompt ?? "",
        );
        json(res, 202, task);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "continue failed",
        });
      }
      return;
    }

    const wakeMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/wake$/);
    if (req.method === "POST" && wakeMatch) {
      try {
        await tasks.wakeSession(wakeMatch[1]!);
        const task = tasks.getTask(wakeMatch[1]!);
        json(res, 200, task ?? { status: "ok" });
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "wake failed",
        });
      }
      return;
    }

    const terminateMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/terminate$/,
    );
    if (req.method === "POST" && terminateMatch) {
      try {
        const task = await tasks.terminateSession(terminateMatch[1]!);
        json(res, 200, task);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "terminate failed",
        });
      }
      return;
    }

    const terminalMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/terminal$/,
    );
    if (req.method === "POST" && terminalMatch) {
      try {
        const body = JSON.parse(await readBody(req)) as {
          command?: string;
          cwd?: string;
          stream?: boolean;
        };
        const taskId = terminalMatch[1]!;
        const path = body.stream ? "/terminal/stream" : "/terminal";
        const upstream = await tasks.proxyRuntimeRequest(taskId, path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId,
            command: body.command ?? "",
            cwd: body.cwd,
          }),
        });

        if (body.stream) {
          res.writeHead(upstream.status, {
            "Content-Type":
              upstream.headers.get("content-type") ?? "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          if (upstream.body) {
            const reader = upstream.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
          }
          res.end();
          return;
        }

        const payload = await upstream.text();
        res.writeHead(upstream.status, {
          "Content-Type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(payload);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "terminal failed",
        });
      }
      return;
    }

    const filesMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/files$/);
    if (req.method === "GET" && filesMatch) {
      try {
        const taskId = filesMatch[1]!;
        const subPath = url.searchParams.get("path") ?? ".";
        const upstream = await tasks.proxyRuntimeRequest(
          taskId,
          `/files/list?path=${encodeURIComponent(subPath)}`,
        );
        const payload = await upstream.text();
        res.writeHead(upstream.status, {
          "Content-Type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(payload);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "files list failed",
        });
      }
      return;
    }

    const fileReadMatch = url.pathname.match(
      /^\/api\/v1\/tasks\/([^/]+)\/files\/read$/,
    );
    if (req.method === "GET" && fileReadMatch) {
      try {
        const taskId = fileReadMatch[1]!;
        const subPath = url.searchParams.get("path") ?? "";
        const upstream = await tasks.proxyRuntimeRequest(
          taskId,
          `/files/read?path=${encodeURIComponent(subPath)}`,
        );
        const payload = await upstream.text();
        res.writeHead(upstream.status, {
          "Content-Type":
            upstream.headers.get("content-type") ?? "application/json",
        });
        res.end(payload);
      } catch (error) {
        json(res, 400, {
          error: error instanceof Error ? error.message : "file read failed",
        });
      }
      return;
    }

    json(res, 404, { error: "not found" });
  });

  server.listen(options.port, "0.0.0.0", () => {
    console.log(
      `${options.mode ?? "standalone"} listening @ http://0.0.0.0:${options.port}`,
    );
  });
}

async function handleTaskEvents(
  tasks: TaskService,
  taskId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const task =
    tasks.getTask(taskId) ?? (await tasks.getTaskStore().getTask(taskId));
  if (!task) {
    json(res, 404, { error: "task not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const history =
    tasks.getEventHistory(taskId).length > 0
      ? tasks.getEventHistory(taskId)
      : await tasks.getTaskStore().loadEvents(taskId);

  for (const event of history) {
    res.write(formatSSE(event));
  }

  let lastSequence = history.reduce((max, event) => {
    const seq = Number(event.data?.sequence ?? 0);
    return seq > max ? seq : max;
  }, 0);

  const unsubscribe = tasks.getEventBus().subscribe(taskId, (event) => {
    res.write(formatSSE(event));
    const seq = Number(event.data?.sequence ?? 0);
    if (seq > lastSequence) {
      lastSequence = seq;
    }
  });

  const pollDb =
    tasks.getMode() === "brain" && tasks.getTaskStore().isEnabled();
  const pollInterval = pollDb
    ? setInterval(async () => {
        const fresh = await tasks
          .getTaskStore()
          .loadEventsSince(taskId, lastSequence);
        for (const event of fresh) {
          res.write(formatSSE(event));
          const seq = Number(event.data?.sequence ?? 0);
          if (seq > lastSequence) {
            lastSequence = seq;
          }
        }
      }, 750)
    : undefined;

  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  req.on("close", () => {
    clearInterval(keepalive);
    if (pollInterval) {
      clearInterval(pollInterval);
    }
    unsubscribe();
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
