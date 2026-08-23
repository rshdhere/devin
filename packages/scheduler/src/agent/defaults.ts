import type { AgentProvider } from "../task/types.js";
import { usesRuntimeAgent, normalizeAgentProvider } from "@devin/types";

export { usesRuntimeAgent, normalizeAgentProvider };

export function resolveDefaultAgent(): AgentProvider {
  const raw = process.env.DEFAULT_AGENT?.trim();
  if (raw === "mock" && process.env.ALLOW_TEMPLATE_AGENT === "true") {
    return "mock";
  }
  return "brain";
}
