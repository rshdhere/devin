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
  type ToolContext,
} from "./tools.js";
import type {
  BrainHarnessOptions,
  BrainHarnessResult,
  ChatMessage,
} from "./types.js";

const DEFAULT_MAX_STEPS = 40;
const FOLLOWUP_MAX_STEPS = 20;
const COMPACT_AFTER = 24;

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

  const client = createOpenAIClient(options.openaiApiKey);
  const toolsClient = createDevboxToolsClient(options.toolGatewayUrl);
  const toolCtx: ToolContext = {
    taskId: options.taskId,
    runtimeBaseUrl: options.runtimeBaseUrl,
    workDir,
    client: toolsClient,
  };

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        workDir,
        followUp: options.followUp,
        sessionContext: options.sessionContext,
        recalledMemory: options.recalledMemory,
      }),
    },
    { role: "user", content: options.prompt },
  ];

  emit({
    type: "agent.log",
    message: `brain harness started (model=${model})`,
    data: { model, followUp: Boolean(options.followUp) },
  });

  let finalSummary = "";
  let steps = 0;

  try {
    while (steps < maxSteps) {
      const abort = options.getAbortReason?.()?.trim();
      if (abort) {
        return { status: "failed", message: abort, agent: "brain" };
      }
      if (Date.now() >= deadline) {
        return {
          status: "failed",
          message: `Brain harness timed out after ${Math.round((options.maxWaitMs ?? 0) / 1000)}s`,
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
        });
      }

      steps += 1;
      const turn = await runModelTurn(client, messages, model);

      if (turn.content?.trim()) {
        emit({ type: "agent.output", message: turn.content.trim() });
      }

      if (turn.toolCalls.length === 0) {
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
        emit({
          type: "agent.tool",
          message: `${call.function.name} ${call.function.arguments.slice(0, 200)}`,
          data: { tool: call.function.name },
        });

        const result = await executeTool(
          toolCtx,
          call.function.name,
          call.function.arguments,
          options.onSaveMemory,
        );

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.content,
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
      return {
        status: "failed",
        message: `Brain harness hit max steps (${maxSteps})`,
        agent: "brain",
      };
    }

    return {
      status: "completed",
      message: finalSummary || "Task completed",
      output: finalSummary,
      agent: "brain",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Brain harness failed";
    emit({ type: "agent.failed", message });
    return { status: "failed", message, agent: "brain" };
  }
}
