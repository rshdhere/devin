import type { AgentProvider } from "./agents";
import { usesRuntimeAgent } from "./agents";

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
      /\b(next[\s._-]*js|nextjs|create-next-app|turbopack|app router|react server components)\b/i,
  },
  {
    runtime: "rust",
    pattern: /\b(rust|cargo\.toml|\bcargo\b|actix|axum|tokio|rocket\s+rs)\b/i,
  },
  {
    runtime: "go",
    // Match "using go" / "golang" / "go api" — bare English "go" alone is ignored.
    pattern:
      /\b(golang|go[\s._-]*lang|(?:using|in|with|via)\s+go|go\s+(?:mod|module|api|server|service|microservice|app|cli|http|chat|todo|web|rest|grpc|websocket|backend)|gin\b|gqlgen|\bfiber\b|chi\s+router)\b/i,
  },
  {
    runtime: "python",
    pattern:
      /\b(python|django|flask|fastapi|uvicorn|gunicorn|pip install|poetry|pytest|py)\b/i,
  },
  {
    runtime: "node",
    pattern:
      /\b(node\.?js|nodejs|express|nestjs|npm|bun\b|javascript|typescript|mongoose|mongodb|koa|hono)\b/i,
  },
];

/** Soft product cues used only when no language/framework was named. */
const AMBIGUOUS_NODE_PATTERN = /\b(todo[\s-]?app|chat[\s-]?app)\b/i;

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

  // "chat app" / "todo app" with no language → Node, not Next.js.
  if (AMBIGUOUS_NODE_PATTERN.test(text)) {
    return "node";
  }

  return "node";
}

export function resolveRuntimeForTask(
  agent: AgentProvider,
  prompt: string,
  explicit?: SandboxRuntime,
): SandboxRuntime {
  if (explicit && isSandboxRuntime(explicit)) {
    if (!usesRuntimeAgent(agent) && explicit === "agent") {
      return inferStackFromPrompt(prompt);
    }
    return explicit;
  }

  // Runtime agents use the stack-specific snapshot too. Every snapshot is
  // built with the agent tooling, so the prompt's stack gets the right
  // compiler/package manager without losing Cursor/Claude execution.
  if (usesRuntimeAgent(agent)) {
    return inferStackFromPrompt(prompt);
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
