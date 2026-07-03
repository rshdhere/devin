import type { AgentProvider } from "./types.js";

export function resolveDefaultAgent(): AgentProvider {
  const raw = process.env.DEFAULT_AGENT?.trim();
  if (raw === "cursor" || raw === "claude" || raw === "mock") {
    return raw;
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return "mock";
  }
  if (process.env.CURSOR_API_KEY?.trim()) {
    return "cursor";
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return "claude";
  }
  return "mock";
}
