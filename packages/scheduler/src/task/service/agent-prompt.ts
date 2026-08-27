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
    "- Run local CLIs with `bun x <tool>` (not `bunx`); if Bun is unavailable, use `npx --yes <tool>`.",
    "- For smoke tests: if `npm run start` fails with EADDRINUSE on port 3000, " +
      "the app may already be running — curl --max-time 5 `http://127.0.0.1:3000/` instead of " +
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
    "- Rust/Cargo and GCC are preinstalled; do not run rustup/apt install loops",
    "- Builds use CARGO_HOME=/workspace/.build/cargo-home and CARGO_TARGET_DIR=/workspace/.build/target",
    "- Keep RUSTUP_HOME=/usr/local/rustup (toolchain on rootfs); do not build under /root",
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
    "Python / workspace:",
    "- Entry point is app.py (Flask scaffold with /health). Start there — never invent app/page.tsx",
    "- PIP_NO_CACHE_DIR is set — do not run `pip cache` housekeeping or delete venvs in loops",
    "- Prefer a single venv in the repo; avoid duplicate `pip install` across multiple envs",
    "- If you see ENOSPC / no space left on device, commit sources and finish — do not rm -rf the repo",
  ];
}

export function vercelDeploymentRequested(prompt: string): boolean {
  return /\b(deploy|publish|ship|host)\b[\s\S]*\bvercel\b/i.test(prompt);
}

function vercelDeploymentGuidance(prompt: string, followUp = false): string[] {
  if (!vercelDeploymentRequested(prompt)) {
    return [];
  }
  if (followUp) {
    return [
      "",
      "Vercel deployment requested (follow-up):",
      "- Deploy this existing repository with `npx --yes vercel --prod --yes`.",
      '- If VERCEL_TOKEN is available, pass `--token "$VERCEL_TOKEN"`.',
      "- Preserve an existing Vercel project link; use VERCEL_ORG_ID and VERCEL_PROJECT_ID when provided.",
      "- Do NOT run local production servers (`bun run start` / `npm start`) or localhost curl/smoke loops — Vercel builds in the cloud.",
      "- At most one quick `bun run build` if you need a compile check; skip it when a recent build already succeeded.",
      "- After the production deploy URL is printed, STOP IMMEDIATELY — do not re-smoke, re-curl, or wait on local ports.",
      "- Report the final deployment URL and any missing Vercel credentials clearly.",
      "",
    ];
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
    "- Prefer the git_commit tool. Message fashion: type(context): lowercase imperative summary (+ optional '- ' bullets).",
    "- NEVER use shell heredocs for commits (no `cat <<'EOF'`, no `$(cat <<EOF)`). They hang the sandbox.",
    `- If using shell git: git commit -m "fix(ui): update background" -m "Co-authored-by: ${bot.name} <${bot.email}>"`,
    `- Every commit MUST include this trailer via a second -m (or via git_commit harness): Co-authored-by: ${bot.name} <${bot.email}>`,
    `- ${bot.name} is the ONLY allowed co-author. Never attribute work to Cursor, Claude, an AI, an assistant, or an agent.`,
    "- If a shell command hangs, stop retrying it and finish remaining file edits.",
    "- Do NOT run local servers (`bun run start` / `npm start` / `npm run start`) on follow-ups.",
    "- Do NOT curl localhost or run smoke checks on follow-ups — edit files, commit, and STOP.",
    "- If port 3000 is already in use (EADDRINUSE), ignore it and do not probe the existing server.",
    "- When the requested change is done, STOP IMMEDIATELY.",
    ...vercelDeploymentGuidance(prompt, true),
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
      : stackRuntime === "python"
        ? "The repository has a thin Python Flask scaffold (app.py + /health + requirements.txt)."
        : stackRuntime === "rust"
          ? "The repository has a thin Rust Cargo scaffold (src/main.rs + Cargo.toml)."
          : stackRuntime === "go"
            ? "The repository has a thin Go scaffold (main.go + go.mod + /health)."
            : "The repository has a thin Node.js scaffold (package.json + src entry + /health).";

  const productRequirements =
    stackRuntime === "nextjs"
      ? [
          "- Extend the existing Next.js App Router project — do not replace it with Express or a plain Node server",
          "- Replace the placeholder page with a real UI for the user's request",
          "- GET / must be user-facing — never leave the scaffold placeholder text",
          "- Keep /health or app/health returning JSON { ok: true }",
          "- Do not finish while the page still shows scaffold placeholder copy",
          "- Add dependencies only when needed; if you do, run bun install and verify start still works",
          "- Smoke-check GET / and /health before finishing",
        ]
      : stackRuntime === "python"
        ? [
            "- Extend app.py into the full product (Flask/FastAPI/etc.) — do NOT create Next.js files (no app/page.tsx, no package.json)",
            "- GET / must serve a real user-facing HTML UI — never leave only /health JSON",
            "- Keep /health returning JSON { ok: true }",
            "- Add Python deps to requirements.txt and install with pip when needed",
            "- Smoke-check GET / (HTML 200) and /health before finishing",
          ]
        : stackRuntime === "rust"
          ? [
              "- Extend the Cargo project (src/main.rs) into the full product — do NOT create Next.js or Node files",
              "- Keep a health/ready check if the app is a server",
              "- Use cargo build (debug) for smoke tests; do not invent package.json",
            ]
          : stackRuntime === "go"
            ? [
                "- Extend main.go into the full product — do NOT create Next.js or Node files",
                "- GET / must serve a real user-facing HTML UI — never leave mux/net/http '404 page not found'",
                "- Keep /health returning JSON { ok: true }",
                "- Use go run / go test; do not invent package.json or app/page.tsx",
                "- Smoke-check GET / (HTML 200) and /health before finishing",
              ]
            : [
                "- Replace the placeholder with a real UI + API for the user's request",
                "- GET / must be user-facing — never leave Express 'Cannot GET /' or a scaffold-only page",
                "- Keep /health returning JSON { ok: true }",
                "- Do not finish while the page still says 'Scaffold is running'",
                "- Do not create a Next.js App Router tree unless the user asked for Next.js",
                "- Add dependencies only when needed; if you do, run bun install and verify start still works",
                "- Smoke-check GET / and /health before finishing",
              ];

  return [
    `Repository ${repository} is cloned at /workspace/${repoCwd}. Work in that directory.`,
    ownerLine,
    "",
    scaffoldLine,
    "You are the implementer — build the full product the user asked for. Do not leave the scaffold untouched.",
    "Requirements:",
    ...productRequirements,
    ...nextjsPromptGuidance(stackRuntime),
    ...rustPromptGuidance(stackRuntime),
    ...pythonPromptGuidance(stackRuntime),
    ...vercelDeploymentGuidance(prompt),
    "",
    "Git / commits:",
    "- Commit incrementally after meaningful steps (API, UI, features, polish)",
    "- Make at least 3 focused commits beyond the scaffold — multiple commits are required",
    "- Use the git_commit tool (not shell git commit)",
    "- Commit messages MUST use Conventional Commits fashion (AGENTS.md):",
    "  type(context): lowercase imperative summary",
    "  optional blank line + up to 4 '- ' bullets describing technical changes",
    "  types: feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert",
    "  good: feat(ui): add flappy bird canvas",
    "  bad: Implemented Flappy Bird game UI. / Various updates / feat: implement flappy bird game UI",
    `- Do NOT put Co-authored-by lines in git_commit — the harness adds Co-authored-by: ${bot.name} <${bot.email}> automatically`,
    "- Keep subjects under ~72 chars; never commit with only a co-author trailer",
    "- Do not spam identical commit subjects — each commit must cover a new focused change",
    "- NEVER use shell heredocs for commits (no `cat <<'EOF'`, no `$(cat <<EOF)`). They hang the sandbox.",
    greenfieldRepo
      ? "- Do NOT run git push — commit locally only; the control plane syncs to GitHub automatically while you work and after you finish"
      : "- Push to the working branch as you go when possible",
    `- ${bot.name} is the ONLY allowed co-author. Never attribute a commit or pull ` +
      "request to Cursor, Claude, an AI, an assistant, or an agent — no " +
      "`Co-authored-by: Cursor Agent`, no `Generated with ...` lines",
    "- If git push is rejected, stop retrying — the control plane finalizes and pushes on completion or timeout",
    "- If a shell command hangs, stop retrying it and finish remaining file edits; control plane finalizes git",
    "- After smoke tests pass and you have ≥3 product commits, STOP IMMEDIATELY — do not clean caches, du, rm -rf target/node_modules, or start extra polish loops",
    "",
    "Sandbox resilience:",
    "- If shell commands fail (ENOMEM, spawn errors), keep writing files with edit tools",
    "- Do not launch subagents or long retry loops for shell — finish the product on disk",
    stackRuntime === "nextjs" || stackRuntime === "node" || !stackRuntime
      ? "- Prefer zero-dependency Node.js (built-in http + SSE) when bun install cannot run"
      : "- Prefer the stack's standard toolchain; do not switch languages mid-task",
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
