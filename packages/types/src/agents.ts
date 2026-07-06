export type AgentProvider = "cursor" | "claude" | "mock";

export function usesRuntimeAgent(agent: AgentProvider): boolean {
  return agent === "cursor" || agent === "claude";
}

export function isTemplateAgent(agent: AgentProvider): boolean {
  return agent === "mock";
}
