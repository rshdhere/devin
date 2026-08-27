const FORBIDDEN_COAUTHOR =
  /co-authored-by:\s*.*(cursor|claude|anthropic|openai|codex|copilot|gemini)/i;

const ANY_COAUTHOR = /^co-authored-by:/i;

const CONVENTIONAL_TYPES =
  "feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert";

const CONVENTIONAL_SUBJECT = new RegExp(
  `^(${CONVENTIONAL_TYPES})(\\([a-z0-9][a-z0-9/_-]{0,32}\\))?:\\s+(.+)$`,
  "i",
);

function isCoAuthorTrailer(line: string): boolean {
  return ANY_COAUTHOR.test(line.trim());
}

export function resolveBotCommitAuthor(): { name: string; email: string } {
  const name = process.env.GITHUB_BOT_NAME?.trim() || "baby-devin-bot";
  const email =
    process.env.GITHUB_BOT_EMAIL?.trim() ||
    "baby-devin-bot@users.noreply.github.com";
  return { name, email };
}

/** Lowercase the imperative verb after type(context): — per AGENTS.md. */
function normalizeImperativeSummary(summary: string): string {
  const trimmed = summary.trim().replace(/[.;:,]+$/g, "");
  if (!trimmed) {
    return "update project";
  }
  // Strip leading "Added/Implemented/Updated …" → imperative.
  const stripped = trimmed
    .replace(
      /^(added|implemented|implements|implement|updated|created|fixed|improved|changed|refactored)\s+/i,
      "",
    )
    .trim();
  const words = (stripped || trimmed).split(/\s+/);
  if (words[0]) {
    words[0] = words[0].toLowerCase();
  }
  // Prefer an imperative verb when the summary is a noun phrase.
  const first = words[0] ?? "update";
  if (
    !/^(add|fix|update|remove|rename|move|wire|implement|introduce|prevent|support|improve|refactor|document|test|build|ship)\b/i.test(
      first,
    )
  ) {
    return `add ${words.join(" ")}`.slice(0, 72);
  }
  return words.join(" ").slice(0, 72);
}

/**
 * Shape Brain commit subjects like AGENTS.md Conventional Commits:
 * `type(context): imperative summary`
 */
export function normalizeConventionalSubject(rawSubject: string): string {
  const subject = rawSubject.trim().replace(/\s+/g, " ");
  if (!subject || isCoAuthorTrailer(subject)) {
    return "chore(repo): update project files";
  }

  const match = subject.match(CONVENTIONAL_SUBJECT);
  if (match) {
    const type = match[1]!.toLowerCase();
    const scope = match[2]?.toLowerCase() ?? "";
    const summary = normalizeImperativeSummary(match[3] ?? "");
    return `${type}${scope}: ${summary}`.slice(0, 72);
  }

  // Bare "feat: …" without scope — keep type, normalize summary.
  const bare = subject.match(
    new RegExp(`^(${CONVENTIONAL_TYPES}):\\s*(.+)$`, "i"),
  );
  if (bare) {
    return `${bare[1]!.toLowerCase()}: ${normalizeImperativeSummary(bare[2] ?? "")}`.slice(
      0,
      72,
    );
  }

  return `feat: ${normalizeImperativeSummary(subject)}`.slice(0, 72);
}

function extractBulletPoints(lines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    const bullet = t.match(/^[-*]\s+(.+)$/);
    if (bullet?.[1]) {
      const text = bullet[1].trim().replace(/[.;]+$/g, "");
      if (text && !isCoAuthorTrailer(text)) {
        bullets.push(`- ${text}`);
      }
    }
    if (bullets.length >= 4) {
      break;
    }
  }
  return bullets;
}

/**
 * Ensure every Brain git_commit follows AGENTS.md Conventional Commits fashion
 * and always attaches baby-devin-bot (product attribution trailer).
 */
export function ensureBotCommitMessage(raw: string): string {
  const bot = resolveBotCommitAuthor();
  const trailer = `Co-authored-by: ${bot.name} <${bot.email}>`;
  const trimmed = raw.trim();

  const contentLines: string[] = [];
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t || isCoAuthorTrailer(t) || FORBIDDEN_COAUTHOR.test(t)) {
      continue;
    }
    contentLines.push(t);
  }

  const subject = normalizeConventionalSubject(contentLines[0] ?? "");
  const bullets = extractBulletPoints(contentLines.slice(1));
  const body = [...bullets, trailer].join("\n");
  return `${subject}\n\n${body}`;
}
