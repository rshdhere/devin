export type AgentProvider = "brain" | "mock";

export const BRAIN_AGENT_MODELS = [
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
] as const;

export type BrainAgentModelId = (typeof BRAIN_AGENT_MODELS)[number]["id"];

export const DEFAULT_BRAIN_AGENT_MODEL: BrainAgentModelId = "gpt-4o-mini";

const KNOWN_BRAIN_MODELS = new Set<string>(
  BRAIN_AGENT_MODELS.map((model) => model.id),
);

/** Map legacy Cursor model ids and unknown values to a cheap OpenAI default. */
export function resolveBrainAgentModel(
  raw: string | undefined | null,
  fallback?: string | undefined | null,
): BrainAgentModelId {
  const trimmed = (raw?.trim() || fallback?.trim() || "").toLowerCase();
  if (!trimmed || trimmed === "auto") {
    return DEFAULT_BRAIN_AGENT_MODEL;
  }
  if (KNOWN_BRAIN_MODELS.has(trimmed)) {
    return trimmed as BrainAgentModelId;
  }
  return DEFAULT_BRAIN_AGENT_MODEL;
}

export function brainAgentModelLabel(modelId: string): string {
  const resolved = resolveBrainAgentModel(modelId);
  const match = BRAIN_AGENT_MODELS.find((model) => model.id === resolved);
  return match?.label ?? resolved;
}

/** @deprecated Use resolveBrainAgentModel — kept for transitional imports. */
export const resolveCursorAgentModel = resolveBrainAgentModel;
/** @deprecated Use brainAgentModelLabel */
export const cursorAgentModelLabel = brainAgentModelLabel;
/** @deprecated */
export const CURSOR_AGENT_MODELS = BRAIN_AGENT_MODELS;
/** @deprecated */
export const DEFAULT_CURSOR_AGENT_MODEL = DEFAULT_BRAIN_AGENT_MODEL;
/** @deprecated */
export type CursorAgentModelId = BrainAgentModelId;

/** Sessions that keep a Firecracker Devbox for follow-ups / desktop. */
export function usesDevboxSession(agent: AgentProvider): boolean {
  return agent === "brain" || agent === "mock";
}

/** @deprecated Use usesDevboxSession — formerly meant in-guest Cursor/Claude. */
export function usesRuntimeAgent(agent: AgentProvider): boolean {
  return usesDevboxSession(agent);
}

export function isTemplateAgent(agent: AgentProvider): boolean {
  return agent === "mock";
}

/** Coerce legacy cursor/claude task agents to brain. */
export function normalizeAgentProvider(
  raw: string | undefined | null,
): AgentProvider {
  const value = raw?.trim().toLowerCase();
  if (value === "mock") {
    return "mock";
  }
  return "brain";
}
