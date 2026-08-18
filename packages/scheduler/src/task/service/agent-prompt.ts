import type { StackRuntime } from "@devin/types";
import type { TaskEvent } from "@devin/events";
import type { GitHubUserIdentity } from "../../github/client.js";
import { resolveBotAuthor } from "./config.js";

/**
 * Skill installs are six cold `npx` fetches inside the microVM before any
 * product code gets written, which dominated run time. Opt in explicitly.
 */
export function agentSkillsEnabled(): boolean {
  return process.env.AGENT_SKILLS_ENABLED?.trim().toLowerCase() === "true";
}

export function agentSkillGuidance(): string[] {
  if (!agentSkillsEnabled()) {
    return [];
  }
  return [
    "- Optionally install agent skills first (skip any that fail — do not retry):",
    "  - `npx --yes skills add https://github.com/anthropics/skills --skill frontend-design`",
    "  - `npx --yes skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-best-practices`",
    "  - `npx --yes skills add https://github.com/101-skills/skills --skill landing-page-design`",
  ];
}

export function nextjsPromptGuidance(stackRuntime?: StackRuntime): string[] {
  if (stackRuntime !== "nextjs") {
    return [];
  }
  return [
    "",
    "Next.js UI requirements:",
    "- Build the app with Next.js (App Router) and TypeScript",
    "- Use shadcn/ui for component styling when it is already configured; " +
      "initialize it with `npx --yes shadcn@latest init -d` only if the project " +
      "has no styling setup yet (Tailwind CSS is required)",
    "- Prefer writing components directly over running many `shadcn add` commands — " +
      "each npx call is slow in the sandbox",
    "- Apply solid visual design: clear layout, consistent spacing, accessible " +
      "contrast, responsive behaviour, and hover/focus states",
    ...agentSkillGuidance(),
    "- Verify `bun run build` succeeds before finishing",
    "- For smoke tests: if `npm run start` fails with EADDRINUSE on port 3000, " +
      "the app may already be running — curl `http://127.0.0.1:3000/` instead of " +
      "starting a second server (or use `PORT=3001 npm run start`)",
    "",
    "Work efficiently — the run has a hard timeout:",
    "- Ship a working product first, then polish if time remains",
    "- Do not re-run installs that already succeeded",
    "- Narrate what you are doing in short messages so progress is visible",
  ];
}

export function rustPromptGuidance(stackRuntime?: StackRuntime): string[] {
  if (stackRuntime !== "rust") {
    return [];
  }
  return [
    "",
    "Rust / workspace disk:",
    "- Prefer `cargo build` (debug) for smoke tests — avoid `cargo build --release` unless necessary",
    "- Builds use CARGO_TARGET_DIR=/workspace/.build/target — do not build under /root",
    "- If you see 'No space left on device', stop cleaning loops; commit sources and finish",
    "- After a successful binary smoke test, remove large `target/debug/deps` if you need space",
  ];
}

export function pythonPromptGuidance(stackRuntime?: StackRuntime): string[] {
  if (stackRuntime !== "python") {
    return [];
  }
  return [
    "",
    "Python / workspace disk:",
    "- PIP_NO_CACHE_DIR is set — do not run `pip cache` housekeeping or delete venvs in loops",
    "- Prefer a single venv in the repo; avoid duplicate `pip install` across multiple envs",
    "- If you see ENOSPC / no space left on device, commit sources and finish — do not rm -rf the repo",
  ];
}

export function vercelDeploymentRequested(prompt: string): boolean {
  return /\b(deploy|publish|ship|host)\b[\s\S]*\bvercel\b/i.test(prompt);
}

function vercelDeploymentGuidance(prompt: string): string[] {
  if (!vercelDeploymentRequested(prompt)) {
    return [];
  }
  return [
    "",
    "Vercel deployment requested:",
    "- Deploy this existing repository to Vercel after verifying the app builds.",
    "- Vercel is not assumed to be installed in the microVM.",
    "- Bootstrap and verify it in the microVM with `npx --yes vercel --version`.",
    "- Then deploy with `npx --yes vercel --prod --yes`.",
    '- If VERCEL_TOKEN is available, pass `--token "$VERCEL_TOKEN"`.',
    "- Preserve an existing Vercel project link; use VERCEL_ORG_ID and VERCEL_PROJECT_ID when provided.",
    "- Report the final deployment URL and any missing Vercel credentials clearly.",
    "",
  ];
}

export type BuildAgentPromptOptions = {
  /** Resume an existing sandbox session with a new user request. */
  followUp?: boolean;
  greenfieldRepo?: boolean;
  /** Bounded, durable context reconstructed from the task event history. */
  sessionContext?: string;
  /** The original devbox was unavailable and has been rebuilt. */
  sessionRecovery?: boolean;
};

export function buildFollowUpSessionContext(
  initialPrompt: string,
  events: TaskEvent[],
  maxCharacters = 6_000,
): string {
  const meaningful = events
    .filter((event) => {
      if (event.type === "agent.log" || event.type === "agent.tool") {
        return false;
      }
      const prompt =
        typeof event.data?.prompt === "string" ? event.data.prompt.trim() : "";
      return Boolean(prompt || event.message.trim());
    })
    .slice(-24)
    .map((event) => {
      const prompt =
        typeof event.data?.prompt === "string" ? event.data.prompt.trim() : "";
      const detail = prompt ? ` User request: ${prompt}` : "";
      return `- ${event.type}: ${event.message.trim()}${detail}`;
    });

  const lines = [
    `Initial user request: ${initialPrompt.trim()}`,
    ...meaningful,
  ];
  let context = lines.join("\n");
  if (context.length > maxCharacters) {
    context = context.slice(-maxCharacters);
    context = `[Earlier context compacted; repository files and git history remain authoritative.]\n${context}`;
  }
  return context;
}

export function buildFollowUpAgentPrompt(
  prompt: string,
  repository: string,
  repoCwd: string,
  owner?: GitHubUserIdentity,
  sessionContext?: string,
  sessionRecovery = false,
): string {
  const bot = resolveBotAuthor();
  const ownerLine = owner
    ? `Repository owner: ${owner.login}. You are committing on their behalf.`
    : "Repository owner: connected GitHub user.";

  return [
    `Repository ${repository} is already available at /workspace/${repoCwd}.`,
    sessionRecovery
      ? "The previous devbox was unavailable; this is a fresh replacement microVM restored from the repository."
      : "This is the same persisted devbox microVM as the previous run.",
    "Do not choose or create another sandbox. Work only in the repository path above.",
    ownerLine,
    "",
    "This is a follow-up in an existing session.",
    "The repository and current files are the source of truth — inspect them before acting.",
    sessionContext
      ? [
          "",
          "Bounded session context (older details may be compacted):",
          sessionContext,
        ].join("\n")
      : "",
    "Apply ONLY the new user request below. Do not rebuild the product from scratch.",
    "Do not reinstall dependencies, re-scaffold, or re-run full production builds/smoke loops unless the request requires it.",
    "Make one or more focused commits for this change only.",
    "- NEVER use shell heredocs for commits (no `cat <<'EOF'`, no `$(cat <<EOF)`). They hang the sandbox.",
    `- Commit with two -m flags only, e.g. git commit -m "fix: update background" -m "Co-authored-by: ${bot.name} <${bot.email}>"`,
    `- Every commit MUST include this trailer via a second -m: Co-authored-by: ${bot.name} <${bot.email}>`,
    `- ${bot.name} is the ONLY allowed co-author. Never attribute work to Cursor, Claude, an AI, an assistant, or an agent.`,
    "- If a shell command hangs, stop retrying it and finish remaining file edits.",
    "- When the requested change is done, STOP IMMEDIATELY.",
    ...vercelDeploymentGuidance(prompt),
    "",
    prompt,
  ].join("\n");
}

export function buildAgentPrompt(
  prompt: string,
  repository: string,
  repoCwd: string,
  owner?: GitHubUserIdentity,
  stackRuntime?: StackRuntime,
  greenfieldRepoOrOptions?: boolean | BuildAgentPromptOptions,
): string {
  const options: BuildAgentPromptOptions =
    typeof greenfieldRepoOrOptions === "object" && greenfieldRepoOrOptions
      ? greenfieldRepoOrOptions
      : { greenfieldRepo: Boolean(greenfieldRepoOrOptions) };

  if (options.followUp) {
    return buildFollowUpAgentPrompt(
      prompt,
      repository,
      repoCwd,
      owner,
      options.sessionContext,
      options.sessionRecovery,
    );
  }

  const greenfieldRepo = options.greenfieldRepo === true;
  const bot = resolveBotAuthor();
  const ownerLine = owner
    ? `Repository owner: ${owner.login}. You are committing on their behalf.`
    : "Repository owner: connected GitHub user.";

  const scaffoldLine =
    stackRuntime === "nextjs"
      ? "The repository has a thin Next.js App Router scaffold (app/page.tsx + /health API route)."
      : "The repository only has a thin runnable scaffold (health + placeholder UI).";

  const productRequirements =
    stackRuntime === "nextjs"
      ? [
          "- Extend the existing Next.js App Router project — do not replace it with Express or a plain Node server",
          "- Replace the placeholder page with a real UI for the user's request",
          "- GET / must be user-facing — never leave the scaffold placeholder text",
          "- Keep /health or app/health returning JSON { ok: true }",
          "- Do not finish while the page still shows scaffold placeholder copy",
        ]
      : [
          "- Replace the placeholder with a real UI + API for the user's request",
          "- GET / must be user-facing — never leave Express 'Cannot GET /' or a scaffold-only page",
          "- Keep /health returning JSON { ok: true }",
          "- Do not finish while the page still says 'Scaffold is running'",
        ];

  return [
    `Repository ${repository} is cloned at /workspace/${repoCwd}. Work in that directory.`,
    ownerLine,
    "",
    scaffoldLine,
    "You are the implementer — build the full product the user asked for. Do not leave the scaffold untouched.",
    "Requirements:",
    ...productRequirements,
    "- Add dependencies only when needed; if you do, run bun install and verify start still works",
    "- Smoke-check GET / and /health before finishing",
    ...nextjsPromptGuidance(stackRuntime),
    ...rustPromptGuidance(stackRuntime),
    ...pythonPromptGuidance(stackRuntime),
    ...vercelDeploymentGuidance(prompt),
    "",
    "Git / commits:",
    "- Commit incrementally after meaningful steps (API, UI, features, polish)",
    "- Make at least 3 focused commits beyond the scaffold — multiple commits are required",
    "- NEVER use shell heredocs for commits (no `cat <<'EOF'`, no `$(cat <<EOF)`). They hang the sandbox.",
    `- Commit with two -m flags only, e.g. git commit -m "feat: add feed API" -m "Co-authored-by: ${bot.name} <${bot.email}>"`,
    "- Keep the subject under ~72 chars; put the co-author trailer only in the second -m",
    greenfieldRepo
      ? "- Do NOT run git push — commit locally only; the control plane syncs to GitHub automatically while you work and after you finish"
      : "- Push to the working branch as you go when possible",
    `- Every commit MUST include this trailer via a second -m (never a heredoc body): Co-authored-by: ${bot.name} <${bot.email}>`,
    `- ${bot.name} is the ONLY allowed co-author. Never attribute a commit or pull ` +
      "request to Cursor, Claude, an AI, an assistant, or an agent — no " +
      "`Co-authored-by: Cursor Agent`, no `Generated with ...` lines",
    "- If git push is rejected, stop retrying — the control plane finalizes and pushes on completion or timeout",
    "- If a shell command hangs, stop retrying it and finish remaining file edits; control plane finalizes git",
    "- After smoke tests pass and you have ≥3 product commits, STOP IMMEDIATELY — do not clean caches, du, rm -rf target/node_modules, or start extra polish loops",
    "",
    "Sandbox resilience:",
    "- If shell/bun commands fail (ENOMEM, spawn errors), keep writing files with edit tools",
    "- Do not launch subagents or long retry loops for shell — finish the product on disk",
    "- Prefer zero-dependency Node.js (built-in http + SSE) when bun install cannot run",
    "- The control plane runs tests, commits, and push after you finish or on timeout",
    "- Never spend time on disk cleanup or build-artifact housekeeping; exit so the session can mark Done",
    "",
    "Sandbox tooling:",
    "- GITHUB_TOKEN is available for gh and git",
    "- Run tests before finishing when applicable",
    "- You may commit, push, open pull requests, and create issues with gh",
    "",
    prompt,
  ].join("\n");
}
