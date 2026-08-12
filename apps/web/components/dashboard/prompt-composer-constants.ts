export const MIN_TEXTAREA_HEIGHT = 72;

export const textareaSpring = {
  type: "spring" as const,
  stiffness: 420,
  damping: 32,
  mass: 0.85,
};

export const agentOptions = [
  {
    id: "cursor" as const,
    label: "Cursor",
    description: "Default — agent runs in the devbox",
  },
  {
    id: "claude" as const,
    label: "Claude",
    description: "Claude Code in the devbox",
  },
] as const;

export type AgentId = (typeof agentOptions)[number]["id"];

export type RepoMode = "existing" | "create";
