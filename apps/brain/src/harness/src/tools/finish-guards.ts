import type {
  DevboxToolsClient,
  ExecResult,
  ToolContext,
  ToolResult,
} from "./types.js";
import { promisify } from "./output.js";

type FinishGuardInput = {
  toolsClient: DevboxToolsClient;
  base: Record<string, unknown>;
  workDir: string;
  stackRuntime: ToolContext["stackRuntime"];
};

function parseSectionPaths(out: string, start: string, end?: string): string[] {
  const i = out.indexOf(start);
  if (i < 0) {
    return [];
  }
  const slice = out.slice(i + start.length);
  const j = end ? slice.indexOf(end) : -1;
  const body = j >= 0 ? slice.slice(0, j) : slice;
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("---") &&
        (line.endsWith(".js") ||
          line.endsWith(".ts") ||
          line.endsWith(".tsx") ||
          line.endsWith(".jsx") ||
          line.endsWith(".html") ||
          line.endsWith(".css")),
    );
}

async function guardJsFinish(
  input: FinishGuardInput,
): Promise<ToolResult | null> {
  const probe = await promisify<ExecResult>(
    input.toolsClient.Exec.bind(input.toolsClient),
    {
      ...input.base,
      command: [
        "set +e",
        "echo '---SCAFFOLD---'",
        "grep -RIl -E 'Scaffold ready|Scaffold is running|Implement the full app|App Router scaffold' --include='*.js' --include='*.ts' --include='*.html' --include='*.tsx' --include='*.jsx' . 2>/dev/null | head -8",
        "echo '---STUB---'",
        "grep -RIl -E 'Play .+ online with friends|View Leaderboard|Start Game|coming soon' --include='*.js' --include='*.ts' --include='*.tsx' --include='*.jsx' --include='*.html' . 2>/dev/null | head -8",
        "echo '---BOARD---'",
        "grep -RIl -E 'chessboard|Chessboard|game-board|GameBoard|grid-cols-8|squares\\.map' --include='*.js' --include='*.ts' --include='*.tsx' --include='*.jsx' --include='*.css' . 2>/dev/null | head -5",
        "echo '---COMMITS---'",
        "git rev-list --count HEAD 2>/dev/null || echo 0",
      ].join("\n"),
      cwd: input.workDir,
      timeoutSec: 45,
      timeout_sec: 45,
    },
  );
  const out = probe.stdout ?? "";
  const leaks = parseSectionPaths(out, "---SCAFFOLD---", "---STUB---");
  const stubs = parseSectionPaths(out, "---STUB---", "---BOARD---");
  const boards = parseSectionPaths(out, "---BOARD---", "---COMMITS---");
  if (leaks.length > 0) {
    return {
      content:
        `Cannot finish yet — scaffold placeholders remain in: ${leaks.slice(0, 5).join(", ")}. ` +
        "Replace them with the full product UI/API, make focused commits, then call finish again.",
    };
  }
  if (stubs.length > 0 && boards.length === 0) {
    return {
      content:
        `Cannot finish yet — marketing stub UI still present (${stubs.slice(0, 3).join(", ")}) without a real interactive product. ` +
        "Build the actual app (e.g. playable board + moves for games), commit, then finish.",
    };
  }
  return null;
}

async function guardNonJsFinish(
  input: FinishGuardInput,
): Promise<ToolResult | null> {
  const stack = input.stackRuntime;
  const entry =
    stack === "python"
      ? "app.py"
      : stack === "rust"
        ? "src/main.rs"
        : "main.go";
  const probe = await promisify<ExecResult>(
    input.toolsClient.Exec.bind(input.toolsClient),
    {
      ...input.base,
      command: [
        "set +e",
        `wc -l < '${entry}' 2>/dev/null || echo 0`,
        "git rev-list --count HEAD 2>/dev/null || echo 0",
        "echo '---ROOT---'",
        "ROOT_OK=no",
        "if command -v ss >/dev/null 2>&1; then",
        "  for p in 3000 3099 8000 8080 5000; do",
        "    code=$(curl -s -o /tmp/devin-root-body -w '%{http_code}' -H 'Accept: text/html,*/*' --max-time 2 \"http://127.0.0.1:$p/\" 2>/dev/null || true)",
        '    if [ "$code" = "200" ]; then',
        "      body=$(head -c 512 /tmp/devin-root-body 2>/dev/null || true)",
        "      if echo \"$body\" | grep -qiE '404 page not found|Cannot GET /'; then continue; fi",
        "      if echo \"$body\" | grep -qiE '<!doctype html|<html|<body|<div|<h1|<form|Scaffold ready'; then ROOT_OK=yes; break; fi",
        "      ROOT_OK=yes; break",
        "    fi",
        "  done",
        "fi",
        'echo "$ROOT_OK"',
        "echo '---HANDLER---'",
        `grep -E 'HandleFunc\\(\"/\"|Handle\\(\"/\"|@app\\.(get|route)\\(\"/\"|route\\(\"/\"|\\(\"/\"\\)' '${entry}' 2>/dev/null | head -3 || true`,
      ].join("\n"),
      cwd: input.workDir,
      timeoutSec: 30,
      timeout_sec: 30,
    },
  );
  const out = (probe.stdout ?? "").trim();
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const entryLines = Number(lines[0] ?? 0);
  if (entryLines > 0 && entryLines < 25) {
    return {
      content:
        `Cannot finish yet — ${entry} still looks like the thin scaffold (~${entryLines} lines). ` +
        "Implement the full product in this stack, make focused commits, then finish.",
    };
  }
  const rootIdx = lines.indexOf("---ROOT---");
  const rootOk = rootIdx >= 0 ? (lines[rootIdx + 1] ?? "no") : "no";
  const handlerIdx = lines.indexOf("---HANDLER---");
  const hasRootHandler =
    handlerIdx >= 0 && lines.slice(handlerIdx + 1).some((l) => l.includes("/"));
  if (rootOk !== "yes" && !hasRootHandler) {
    return {
      content:
        "Cannot finish yet — GET / does not serve a user-facing page (Desktop would show 404). " +
        "Add an HTML UI at `/` (keep `/health`), smoke-check it, commit, then finish.",
    };
  }
  return null;
}

/** Return a refusal ToolResult when product finish gates fail; otherwise null. */
export async function checkProductFinishGuards(
  input: FinishGuardInput,
): Promise<ToolResult | null> {
  const stack = input.stackRuntime;
  const isJs = stack === "nextjs" || stack === "node" || stack === undefined;
  if (isJs) {
    return guardJsFinish(input);
  }
  return guardNonJsFinish(input);
}
