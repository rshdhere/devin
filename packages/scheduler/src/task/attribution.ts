/**
 * Coding CLIs credit themselves as a commit co-author by default, which lists
 * `cursoragent` (or `Claude`) as a contributor on every repository this product
 * ships. The CLI config covers the well-behaved path; the commit-msg hook is the
 * backstop for trailers the model writes by hand.
 */

/** Only the product bot and humans may be credited; tool vendors are stripped. */
export const AGENT_ATTRIBUTION_PATTERN =
  "^[[:space:]]*(" +
  "co-authored-by:[[:space:]]*.*(cursor|claude|anthropic|openai|codex|copilot|gemini)" +
  "|(.*[[:space:]])?(generated|created|authored)[[:space:]]+(with|by|using)[[:space:]]+(cursor|claude|ai|an[[:space:]]+ai)" +
  ")";

export const CLI_CONFIG_RELATIVE_PATH = ".cursor/cli-config.json";
export const HOOKS_RELATIVE_PATH = ".devin/githooks";

const DEFAULT_CLI_CONFIG_JSON = JSON.stringify({
  version: 1,
  attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
});

const CLI_CONFIG_MERGE_SCRIPT = [
  'const fs = require("fs");',
  "const target = process.argv[1];",
  "let config = {};",
  'try { config = JSON.parse(fs.readFileSync(target, "utf8")) || {}; } catch {}',
  "config.attribution = {",
  "  ...(config.attribution || {}),",
  "  attributeCommitsToAgent: false,",
  "  attributePRsToAgent: false,",
  "};",
  "fs.writeFileSync(target, JSON.stringify(config, null, 2));",
].join(" ");

export function buildCommitMsgHook(): string {
  return [
    "#!/bin/sh",
    'msg="$1"',
    '[ -f "$msg" ] || exit 0',
    'cleaned="$msg.devin-cleaned"',
    `grep -viE ${shellSingleQuote(AGENT_ATTRIBUTION_PATTERN)} "$msg" > "$cleaned" || true`,
    // Never hand git an empty message — that aborts the commit outright.
    `if grep -qE '[^[:space:]#]' "$cleaned"; then`,
    '  mv "$cleaned" "$msg"',
    "else",
    '  rm -f "$cleaned"',
    "fi",
    "exit 0",
  ].join("\n");
}

/** Disables CLI attribution and installs the trailer-stripping commit-msg hook. */
export function buildAgentAttributionOptOutScript(): string {
  return [
    "set -e",
    'if [ -z "${HOME}" ]; then export HOME=/root; fi',
    `mkdir -p "$HOME/.cursor" "$HOME/${HOOKS_RELATIVE_PATH}"`,
    `config="$HOME/${CLI_CONFIG_RELATIVE_PATH}"`,
    'if [ -s "$config" ] && command -v node >/dev/null 2>&1; then',
    `  node -e ${shellSingleQuote(CLI_CONFIG_MERGE_SCRIPT)} "$config"`,
    "else",
    `  printf '%s\\n' ${shellSingleQuote(DEFAULT_CLI_CONFIG_JSON)} > "$config"`,
    "fi",
    `hook="$HOME/${HOOKS_RELATIVE_PATH}/commit-msg"`,
    "cat > \"$hook\" <<'DEVIN_COMMIT_MSG_HOOK'",
    buildCommitMsgHook(),
    "DEVIN_COMMIT_MSG_HOOK",
    'chmod +x "$hook"',
    `git config --global core.hooksPath "$HOME/${HOOKS_RELATIVE_PATH}"`,
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
