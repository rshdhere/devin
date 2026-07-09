import type { AgentProvider } from "./types.js";
import { usesRuntimeAgent } from "@devin/types";

export { usesRuntimeAgent };

export function resolveDefaultAgent(): AgentProvider {
  const raw = process.env.DEFAULT_AGENT?.trim();
  if (raw === "cursor" || raw === "claude") {
    return raw;
  }
  // Brain-first architecture: runtime agents only. Template (mock) is opt-in.
  if (raw === "mock" && process.env.ALLOW_TEMPLATE_AGENT === "true") {
    return "mock";
  }
  return "cursor";
}
