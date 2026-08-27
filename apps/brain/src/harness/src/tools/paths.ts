import type { ToolContext } from "./types.js";

/**
 * File tools resolve against the guest /workspace root. Models usually pass
 * repo-relative paths (app/page.tsx); prefix with workDir so they land in
 * /workspace/<repo>/… instead of /workspace/app/….
 */
export function resolveRepoPath(workDir: string, rawPath: string): string {
  const root = workDir.trim().replace(/^\/+|\/+$/g, "") || "repo";
  let p = rawPath.trim().replace(/\\/g, "/");
  if (!p || p === ".") {
    return root;
  }

  while (p.startsWith("/workspace/")) {
    p = p.slice("/workspace/".length);
  }
  while (p.startsWith("workspace/")) {
    p = p.slice("workspace/".length);
  }
  p = p
    .replace(/^\/+/, "")
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== ".")
    .join("/");

  if (!p || p === root || p.startsWith(`${root}/`)) {
    return p || root;
  }
  return `${root}/${p}`;
}

export function isForbiddenProjectPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/node_modules/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/.next/") ||
    normalized.startsWith(".next/") ||
    normalized.includes("/dist/") ||
    normalized.startsWith("dist/") ||
    normalized.includes("/.git/") ||
    normalized.includes("/__pycache__/") ||
    normalized.includes("/target/debug/") ||
    normalized.includes("/target/release/")
  );
}

/** Block Next.js App Router paths when the task stack is python/rust/go. */
export function isWrongStackPath(
  stack: ToolContext["stackRuntime"],
  path: string,
): boolean {
  if (stack !== "python" && stack !== "rust" && stack !== "go") {
    return false;
  }
  const p = path.replace(/\\/g, "/").toLowerCase();
  return (
    /(^|\/)app\/.+\.(tsx|jsx)$/.test(p) ||
    p.endsWith("/app/layout.tsx") ||
    p.endsWith("next.config.js") ||
    p.endsWith("next.config.mjs") ||
    p.endsWith("next.config.ts")
  );
}

export function wrongStackMessage(stack: string, path: string): string {
  return (
    `refused ${path} — this task is a ${stack} project. ` +
    "Do not create Next.js App Router files (app/*.tsx). " +
    "Use list_dir and edit the stack entry files instead."
  );
}

export function isForegroundServerCommand(command: string): boolean {
  const c = command.trim();
  // Only allow explicitly backgrounded servers — `timeout Ns bun …` still kills
  // the process before a follow-up curl can succeed (classic smoke-loop trap).
  if (/\bnohup\b/i.test(c) || /(?:^|[\s;])&(?:\s|$)/.test(c)) {
    return false;
  }
  // Long-lived servers hang the harness (UI spinner stuck on Ran `bun start`).
  return (
    /\b(bun|npm|yarn|pnpm)\s+(run\s+)?(start|dev)\b/i.test(c) ||
    /\b(bun|npm|yarn|pnpm)\s+start\b/i.test(c) ||
    // Direct entry points (node/bun src/index.js) also hang without &/nohup.
    /\b(bun|node|tsx|ts-node)\s+(\S+\/)?(src\/)?(index|server|main|app)\.(js|ts|mjs|cjs)\b/i.test(
      c,
    ) ||
    /\bnext(\s+dev|\s+start)\b/i.test(c) ||
    /\bnpx\s+.*\b(next|vite|webpack-dev-server)\b/i.test(c) ||
    /\b(uvicorn|gunicorn|flask\s+run)\b/i.test(c) ||
    /\bpython(\d+(?:\.\d+)*)?\s+-m\s+(uvicorn|http\.server|flask)\b/i.test(c) ||
    /\bgo\s+run\b/i.test(c) ||
    /\bcargo\s+run\b/i.test(c)
  );
}
