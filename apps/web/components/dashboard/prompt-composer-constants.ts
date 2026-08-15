export const MIN_TEXTAREA_HEIGHT = 72;

export const CHAT_COLUMN_WIDTH = 395;

export const workspaceShellClassName =
  "overflow-hidden rounded-2xl border border-white/15 bg-[#1c1c1c]/80 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),0_0_0_1px_rgba(255,255,255,0.04),0_16px_48px_rgba(0,0,0,0.45)]";

/** Smooth decelerate — avoids harsh stops. */
export const chatLaunchEase = [0.16, 1, 0.3, 1] as const;

export const chatLaunchTransition = {
  duration: 0.55,
  ease: chatLaunchEase,
} as const;

/** Wait for expand to finish before routing. */
export const CHAT_MORPH_MS = 560;

/** Hold workspace diamond before crossfade. */
export const CHAT_MORPH_HANDOFF_MS = 280;

/** Crossfade overlay → real panels. */
export const CHAT_MORPH_FADE_MS = 200;

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

export type MorphRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};
