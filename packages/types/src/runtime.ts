import type { AgentProvider } from "./agents.js";
import { usesRuntimeAgent } from "./agents.js";

/** Firecracker golden snapshot names under /var/lib/devin/snapshots/ */
export const SANDBOX_RUNTIMES = [
  "agent",
  "nextjs",
  "node",
  "go",
  "rust",
  "python",
] as const;

export type SandboxRuntime = (typeof SANDBOX_RUNTIMES)[number];

/** Stack snapshots selectable from a user prompt (excludes agent-only image). */
export type StackRuntime = Exclude<SandboxRuntime, "agent">;

const STACK_RUNTIMES: StackRuntime[] = [
  "nextjs",
  "node",
  "go",
  "rust",
  "python",
];

const PROMPT_RULES: Array<{ runtime: StackRuntime; pattern: RegExp }> = [
  {
    runtime: "nextjs",
    pattern:
      /\b(next\.?js|nextjs|create-next-app|turbopack|app router|react server components)\b/i,
  },
  {
    runtime: "rust",
    pattern: /\b(rust|cargo\.toml|\bcargo\b|actix|axum|tokio|rocket\s+rs)\b/i,
  },
  {
    runtime: "go",
    pattern:
      /\b(golang|go\s+(mod|module|api|server|service|microservice)|\bgin\b|\becho\b|\bfiber\b|chi\s+router)\b/i,
  },
  {
    runtime: "python",
    pattern:
      /\b(python|django|flask|fastapi|uvicorn|gunicorn|pip install|poetry|pytest)\b/i,
  },
  {
    runtime: "node",
    pattern:
      /\b(node\.?js|nodejs|express|nestjs|npm|bun\b|todo[\s-]?app|javascript|typescript|mongoose|mongodb|koa|hono)\b/i,
  },
];

export function isSandboxRuntime(value: string): value is SandboxRuntime {
  return (SANDBOX_RUNTIMES as readonly string[]).includes(value);
}

export function inferStackFromPrompt(prompt: string): StackRuntime {
  const text = prompt.trim();
  if (!text) {
    return "node";
  }

  for (const rule of PROMPT_RULES) {
    if (rule.pattern.test(text)) {
      return rule.runtime;
    }
  }

  return "node";
}

export function resolveRuntimeForTask(
  agent: AgentProvider,
  prompt: string,
  explicit?: SandboxRuntime,
): SandboxRuntime {
  if (explicit && isSandboxRuntime(explicit)) {
    if (usesRuntimeAgent(agent) && explicit !== "agent") {
      return "agent";
    }
    if (!usesRuntimeAgent(agent) && explicit === "agent") {
      return inferStackFromPrompt(prompt);
    }
    return explicit;
  }

  if (usesRuntimeAgent(agent)) {
    return "agent";
  }

  return inferStackFromPrompt(prompt);
}

export function runtimeLabel(runtime: SandboxRuntime): string {
  switch (runtime) {
    case "agent":
      return "Agent (Cursor / Claude)";
    case "nextjs":
      return "Next.js";
    case "node":
      return "Node.js";
    case "go":
      return "Go";
    case "rust":
      return "Rust";
    case "python":
      return "Python";
    default:
      return runtime;
  }
}

export function stackRuntimes(): StackRuntime[] {
  return [...STACK_RUNTIMES];
}
