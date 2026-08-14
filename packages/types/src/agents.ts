export type AgentProvider = "cursor" | "claude" | "mock";

export const CURSOR_AGENT_MODELS = [{ id: "auto", label: "Auto" }] as const;

export type CursorAgentModelId = (typeof CURSOR_AGENT_MODELS)[number]["id"];

export const DEFAULT_CURSOR_AGENT_MODEL: CursorAgentModelId = "auto";

/** Legacy Cursor CLI model ids — map to auto on Pro plans. */
const CURSOR_MODEL_ALIASES: Record<string, CursorAgentModelId> = {
  "composer-2.5": "auto",
  "composer-2.5-fast": "auto",
  "composer-2-fast": "auto",
  "cursor-grok-4.5-medium": "auto",
  "cursor-grok-4.6-medium": "auto",
};

const KNOWN_CURSOR_MODELS = new Set<string>(
  CURSOR_AGENT_MODELS.map((model) => model.id),
);

export function resolveCursorAgentModel(
  raw: string | undefined | null,
  fallback?: string | undefined | null,
): CursorAgentModelId {
  const trimmed = (raw?.trim() || fallback?.trim() || "").toLowerCase();
  if (!trimmed) {
    return DEFAULT_CURSOR_AGENT_MODEL;
  }
  if (CURSOR_MODEL_ALIASES[trimmed]) {
    return CURSOR_MODEL_ALIASES[trimmed]!;
  }
  if (KNOWN_CURSOR_MODELS.has(trimmed)) {
    return trimmed as CursorAgentModelId;
  }
  return DEFAULT_CURSOR_AGENT_MODEL;
}

export function cursorAgentModelLabel(modelId: string): string {
  const resolved = resolveCursorAgentModel(modelId);
  const match = CURSOR_AGENT_MODELS.find((model) => model.id === resolved);
  return match?.label ?? resolved;
}

export function usesRuntimeAgent(agent: AgentProvider): boolean {
  return agent === "cursor" || agent === "claude";
}

export function isTemplateAgent(agent: AgentProvider): boolean {
  return agent === "mock";
}
