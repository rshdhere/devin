import type { AgentProvider } from "./types.js";

export type DraftFilePlan = {
  path: string;
  changeType: "create" | "update";
  summary: string;
};

export type DraftPlan = {
  summary: string;
  steps: string[];
  files: DraftFilePlan[];
};

export type DraftPlannerContext = {
  prompt: string;
  repository?: string;
  createRepository?: string;
  hasTestCommand?: boolean;
  agent?: AgentProvider;
};

export type DraftPlannerCallbacks = {
  onStep?: (step: string, index: number, total: number) => void | Promise<void>;
  onFile?: (
    file: DraftFilePlan,
    index: number,
    total: number,
  ) => void | Promise<void>;
};

const PLANNER_SYSTEM_PROMPT =
  "You are a software planning assistant. Return ONLY valid JSON with keys: summary (string), steps (string array, 3-6 items), files (array of { path, changeType: create|update, summary }). No markdown fences.";

export async function generateDraftPlan(
  ctx: DraftPlannerContext,
  callbacks?: DraftPlannerCallbacks,
): Promise<DraftPlan> {
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey) {
    try {
      const plan = await generateDraftPlanWithOpenAI(openAiKey, ctx);
      await emitPlanProgress(plan, callbacks);
      return plan;
    } catch {
      // try next provider
    }
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    try {
      const plan = await generateDraftPlanWithAnthropic(anthropicKey, ctx);
      await emitPlanProgress(plan, callbacks);
      return plan;
    } catch {
      // fall back to heuristic planner
    }
  }

  const plan = buildHeuristicDraftPlan(ctx);
  await emitPlanProgress(plan, callbacks);
  return plan;
}

async function emitPlanProgress(
  plan: DraftPlan,
  callbacks?: DraftPlannerCallbacks,
): Promise<void> {
  for (const [index, step] of plan.steps.entries()) {
    await callbacks?.onStep?.(step, index, plan.steps.length);
  }
  for (const [index, file] of plan.files.entries()) {
    await callbacks?.onFile?.(file, index, plan.files.length);
  }
}

function buildPlannerUserPrompt(ctx: DraftPlannerContext): string {
  const repoLine = ctx.repository
    ? `Target repository: ${ctx.repository}`
    : ctx.createRepository
      ? `Will create repository: ${ctx.createRepository}`
      : "Will create a new repository";

  return [
    repoLine,
    `Agent runtime: ${ctx.agent ?? "cursor"}`,
    ctx.hasTestCommand ? "Tests will run after implementation." : "",
    "",
    "User request:",
    ctx.prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateDraftPlanWithOpenAI(
  apiKey: string,
  ctx: DraftPlannerContext,
): Promise<DraftPlan> {
  const model = process.env.DRAFT_PLANNER_OPENAI_MODEL?.trim() || "gpt-4o-mini";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLANNER_SYSTEM_PROMPT },
        { role: "user", content: buildPlannerUserPrompt(ctx) },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI planner error ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = payload.choices?.[0]?.message?.content;
  if (!text?.trim()) {
    throw new Error("OpenAI planner returned empty content");
  }

  const parsed = JSON.parse(extractJson(text)) as Partial<DraftPlan>;
  return normalizeDraftPlan(parsed);
}

async function generateDraftPlanWithAnthropic(
  apiKey: string,
  ctx: DraftPlannerContext,
): Promise<DraftPlan> {
  const model =
    process.env.DRAFT_PLANNER_ANTHROPIC_MODEL?.trim() ||
    process.env.DRAFT_PLANNER_MODEL?.trim() ||
    "claude-sonnet-4-20250514";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.2,
      system: PLANNER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildPlannerUserPrompt(ctx),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic planner error ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = payload.content?.find((block) => block.type === "text")?.text;
  if (!text?.trim()) {
    throw new Error("Anthropic planner returned empty content");
  }

  const parsed = JSON.parse(extractJson(text)) as Partial<DraftPlan>;
  return normalizeDraftPlan(parsed);
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text.trim();
}

function normalizeDraftPlan(raw: Partial<DraftPlan>): DraftPlan {
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .map((step) => String(step).trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const files = Array.isArray(raw.files)
    ? raw.files
        .map((file) => ({
          path: String(file.path ?? "").trim(),
          changeType:
            file.changeType === "update"
              ? ("update" as const)
              : ("create" as const),
          summary: String(file.summary ?? "").trim(),
        }))
        .filter((file) => file.path && file.summary)
        .slice(0, 12)
    : [];

  if (steps.length === 0 || files.length === 0) {
    throw new Error("Planner JSON missing steps or files");
  }

  return {
    summary:
      String(raw.summary ?? "").trim() ||
      "Draft prepared for sandbox execution.",
    steps,
    files,
  };
}

export function buildHeuristicDraftPlan(ctx: DraftPlannerContext): DraftPlan {
  const lower = ctx.prompt.toLowerCase();
  const isNode = [
    "node",
    "express",
    "typescript",
    "javascript",
    "api",
    "next.js",
    "nextjs",
    "next js",
    "react",
  ].some((term) => lower.includes(term));

  const files: DraftFilePlan[] = [
    {
      path: "README.md",
      changeType: "update",
      summary: "Document scope, run steps, and delivery notes",
    },
  ];

  if (isNode) {
    files.push(
      {
        path: "package.json",
        changeType: "update",
        summary: "Define scripts and dependencies for the requested app",
      },
      {
        path: "src/index.ts",
        changeType: "create",
        summary: "Create the main server/app entry point",
      },
    );
  } else {
    files.push({
      path: "src/main.ts",
      changeType: "create",
      summary: "Add the main implementation entry point",
    });
  }

  if (lower.includes("todo")) {
    files.push({
      path: "src/routes/todos.ts",
      changeType: "create",
      summary: "Add todo CRUD handlers and validation flow",
    });
  }

  const repoTarget = ctx.repository
    ? `repository ${ctx.repository}`
    : ctx.createRepository
      ? `new repository ${ctx.createRepository}`
      : "a new repository workspace";

  const steps = [
    `Analyze prompt requirements for ${repoTarget}`,
    "Outline implementation plan with incremental file edits",
    "Prepare scaffold and dependency setup before sandbox execution",
    ctx.hasTestCommand
      ? "Run configured tests after implementation"
      : "Run default sanity checks after implementation",
  ];

  return {
    summary:
      "Draft prepared in control-plane. Sandbox execution will apply changes and run tooling.",
    steps,
    files,
  };
}
