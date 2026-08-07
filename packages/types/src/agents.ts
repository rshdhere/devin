export type AgentProvider = "cursor" | "claude" | "mock";

export const CURSOR_AGENT_MODELS = [
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "cursor-grok-4.5-medium", label: "Grok 4.5 Medium" },
] as const;

export type CursorAgentModelId = (typeof CURSOR_AGENT_MODELS)[number]["id"];

export const DEFAULT_CURSOR_AGENT_MODEL: CursorAgentModelId = "composer-2.5";

/** Cursor CLI models that are not enabled on all accounts — map to supported ids. */
const CURSOR_MODEL_ALIASES: Record<string, CursorAgentModelId> = {
  "composer-2.5-fast": "composer-2.5",
  "composer-2-fast": "composer-2.5",
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
  const aliased =
    CURSOR_MODEL_ALIASES[trimmed] ??
    (KNOWN_CURSOR_MODELS.has(trimmed)
      ? (trimmed as CursorAgentModelId)
      : DEFAULT_CURSOR_AGENT_MODEL);
  return aliased;
}

export function cursorAgentModelLabel(modelId: string): string {
  const match = CURSOR_AGENT_MODELS.find((model) => model.id === modelId);
  return match?.label ?? modelId;
}

export function usesRuntimeAgent(agent: AgentProvider): boolean {
  return agent === "cursor" || agent === "claude";
}

export function isTemplateAgent(agent: AgentProvider): boolean {
  return agent === "mock";
}
