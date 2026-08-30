import { buildSystemPrompt, compactMessages } from "./context.js";
import {
  createOpenAIClient,
  resolveOpenAIModel,
  runModelTurn,
  summarizeConversation,
} from "./openai.js";
import {
  createDevboxToolsClient,
  executeTool,
  resolveRepoPath,
  type ToolContext,
} from "./tools.js";
import { normalizeBrainStack } from "./stack.js";
import { wrapToolResult } from "./trust.js";
import type {
  BrainHarnessOptions,
  BrainHarnessResult,
  ChatMessage,
} from "./types.js";

const DEFAULT_MAX_STEPS = 40;
const FOLLOWUP_MAX_STEPS = 20;
const COMPACT_AFTER = 24;

/** Map OpenAI tool names + args into UI-friendly progress detail. */
export function toolProgressDetail(
  name: string,
  rawArgs: string,
  workDir = "repo",
): { tool: string; detail: string; message: string } {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }

  const rawPath =
    typeof args.path === "string"
      ? args.path
      : typeof args.file === "string"
        ? args.file
        : "";
  const path = rawPath ? resolveRepoPath(workDir, rawPath) : "";
  const command = typeof args.command === "string" ? args.command : "";
  const summary = typeof args.summary === "string" ? args.summary : "";
  const message = typeof args.message === "string" ? args.message : "";

  switch (name) {
    case "write_file":
      return {
        tool: "Write",
        detail: path || "file",
        message: `Write ${path || "file"}`,
      };
    case "read_file":
      return {
        tool: "Read",
        detail: path || "file",
        message: `Read ${path || "file"}`,
      };
    case "list_dir":
      return {
        tool: "List",
        detail: path || resolveRepoPath(workDir, "."),
        message: `List ${path || resolveRepoPath(workDir, ".")}`,
      };
    case "shell":
      return {
        tool: "Shell",
        detail: command || "command",
        message: `Shell ${command || "command"}`.slice(0, 200),
      };
    case "git_commit": {
      const subject = (message || "commit").split("\n")[0]?.trim() || "commit";
      return {
        tool: "Commit",
        detail: subject,
        message: `Commit ${subject}`.slice(0, 200),
      };
    }
    case "git_push":
      return {
        tool: "Push",
        detail: typeof args.branch === "string" ? args.branch : "main",
        message: "Push branch",
      };
    case "finish":
      return {
        tool: "Finish",
        detail: summary || "done",
        message: `Finish ${summary || "done"}`.slice(0, 200),
      };
    default:
      return {
        tool: name,
        detail: path || command || summary || "",
        message: `${name} ${(rawArgs || "").slice(0, 160)}`.trim(),
      };
  }
}

export async function runBrainHarness(
  options: BrainHarnessOptions,
): Promise<BrainHarnessResult> {
  const emit = options.onEvent ?? (() => undefined);
  const model = resolveOpenAIModel(options.model);
  const maxSteps =
    options.maxSteps ??
    (options.followUp ? FOLLOWUP_MAX_STEPS : DEFAULT_MAX_STEPS);
  const deadline = Date.now() + (options.maxWaitMs ?? 20 * 60 * 1000);
  const workDir = options.workDir?.trim() || "repo";
  const stackRuntime = normalizeBrainStack(options.stackRuntime);

  const client = createOpenAIClient(options.openaiApiKey);
  const workerUrl = options.executionWorkerUrl?.trim();
  const toolCtx: ToolContext = {
    taskId: options.taskId,
    runtimeBaseUrl: options.runtimeBaseUrl?.trim() || "",
    workDir,
    client: workerUrl
      ? undefined
      : createDevboxToolsClient(options.toolGatewayUrl),
    requireProductImplementation: options.requireProductImplementation,
    stackRuntime,
    executionWorkerUrl: workerUrl || undefined,
  };

  if (!workerUrl && !toolCtx.runtimeBaseUrl) {
    return {
      status: "failed",
      message:
        "Brain harness requires runtimeBaseUrl (standalone) or executionWorkerUrl (Brain mode)",
      agent: "brain",
    };
  }

  // Seed the real file tree so the model does not invent Next.js paths on
  // python/rust/go scaffolds (classic failure: read app/page.tsx → abort).
  let repoListing = "";
  try {
    const listed = await executeTool(
      toolCtx,
      "list_dir",
      JSON.stringify({ path: "." }),
    );
    if (
      listed.content &&
      !/^tool error:|^file not found:|^refused/i.test(listed.content)
    ) {
      repoListing = listed.content.slice(0, 2_000);
    }
  } catch {
    repoListing = "";
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        workDir,
        followUp: options.followUp,
        requireProductImplementation: options.requireProductImplementation,
        stackRuntime,
        sessionContext: options.sessionContext,
        recalledMemory: options.recalledMemory,
        repoListing,
      }),
    },
    { role: "user", content: options.prompt },
  ];

  emit({
    type: "agent.started",
    message: `Brain harness started (model=${model}, workDir=${workDir}, stack=${stackRuntime ?? "auto"})`,
    data: {
      model,
      workDir,
      stackRuntime: stackRuntime ?? null,
      followUp: Boolean(options.followUp),
      agent: "brain",
      toolGateway: options.toolGatewayUrl ?? "127.0.0.1:9095",
      repoListing: repoListing || null,
    },
  });
  emit({
    type: "agent.log",
    message: `brain harness loop ready (maxSteps=${maxSteps})`,
    data: { model, followUp: Boolean(options.followUp), maxSteps },
  });

  let finalSummary = "";
  let steps = 0;

  try {
    while (steps < maxSteps) {
      const abort = options.getAbortReason?.()?.trim();
      if (abort) {
        emit({
          type: "agent.failed",
          message: abort,
          data: { steps, aborted: true },
        });
        return { status: "failed", message: abort, agent: "brain" };
      }
      if (Date.now() >= deadline) {
        const message = `Brain harness timed out after ${Math.round((options.maxWaitMs ?? 0) / 1000)}s`;
        emit({
          type: "agent.failed",
          message,
          data: { steps, timedOut: true },
        });
        return {
          status: "failed",
          message,
          agent: "brain",
        };
      }

      if (messages.length >= COMPACT_AFTER) {
        const summary = await summarizeConversation(client, messages);
        messages.splice(
          0,
          messages.length,
          ...compactMessages(messages, summary),
        );
        emit({
          type: "agent.log",
          message: "compacted conversation context",
          data: { steps },
        });
      }

      steps += 1;

      const turn = await runModelTurn(client, messages, model);

      if (turn.content?.trim()) {
        emit({
          type: "agent.output",
          message: turn.content.trim(),
          data: { step: steps },
        });
      }

      if (turn.toolCalls.length === 0) {
        if (options.requireProductImplementation) {
          messages.push({
            role: "assistant",
            content: turn.content,
          });
          messages.push({
            role: "user",
            content:
              "Do not stop yet. Keep implementing with tools until scaffold placeholders are gone, then call finish.",
          });
          emit({
            type: "agent.log",
            message: "nudged model to keep implementing (no tool calls yet)",
            data: { step: steps },
          });
          continue;
        }
        finalSummary = turn.content?.trim() || "Task completed";
        break;
      }

      messages.push({
        role: "assistant",
        content: turn.content,
        tool_calls: turn.toolCalls,
      });

      let finished = false;
      for (const call of turn.toolCalls) {
        const progress = toolProgressDetail(
          call.function.name,
          call.function.arguments,
          workDir,
        );

        const result = await executeTool(
          toolCtx,
          call.function.name,
          call.function.arguments,
          options.onSaveMemory,
        );

        const skippedCommit =
          call.function.name === "git_commit" &&
          /nothing to commit|skipped duplicate|tool error:|refused /i.test(
            result.content,
          );

        // Emit Progress only for successful work — empty/duplicate commits used
        // to spam "Committed · …" while git history barely moved.
        if (!skippedCommit) {
          emit({
            type: "agent.tool",
            message: progress.message,
            data: {
              tool: progress.tool,
              detail: progress.detail,
              brainTool: call.function.name,
              step: steps,
            },
          });
        }

        emit({
          type: "agent.log",
          message: skippedCommit
            ? `Commit skipped · ${result.content.slice(0, 160)}`
            : `${progress.tool} → ${result.content.slice(0, 180)}`,
          data: {
            tool: progress.tool,
            brainTool: call.function.name,
            step: steps,
            done: Boolean(result.done),
            skipped: skippedCommit,
          },
        });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: wrapToolResult(call.function.name, result.content),
        });

        if (result.done) {
          finalSummary = result.summary || "Task completed";
          finished = true;
          break;
        }
      }

      if (finished) {
        break;
      }
    }

    if (!finalSummary && steps >= maxSteps) {
      // Greenfield: soft-complete so control-plane git assert can accept
      // real product commits instead of failing the whole task as "max steps".
      if (options.requireProductImplementation) {
        const message = `Reached step budget (${maxSteps}); shipping committed work so far`;
        emit({
          type: "agent.completed",
          message,
          data: { steps, maxSteps, model, agent: "brain", softComplete: true },
        });
        return {
          status: "completed",
          message,
          output: message,
          agent: "brain",
        };
      }
      const message = `Brain harness hit max steps (${maxSteps})`;
      emit({ type: "agent.failed", message, data: { steps, maxSteps } });
      return {
        status: "failed",
        message,
        agent: "brain",
      };
    }

    const message = finalSummary || "Task completed";
    emit({
      type: "agent.completed",
      message,
      data: { steps, model, agent: "brain" },
    });
    return {
      status: "completed",
      message,
      output: finalSummary,
      agent: "brain",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Brain harness failed";
    emit({ type: "agent.failed", message, data: { steps } });
    return { status: "failed", message, agent: "brain" };
  }
}
