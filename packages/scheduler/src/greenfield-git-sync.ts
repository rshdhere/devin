export const GREENFIELD_FETCH_TIMEOUT_SEC = 30;
export const GREENFIELD_FETCH_RETRIES = 2;

export function isAgentTimeoutMessage(message: string): boolean {
  return /did not finish within/i.test(message);
}

/** Fetch origin/main with retries; hard-reset working tree onto remote tip. */
export function buildAlignHydratedRepoScript(opts?: {
  hardReset?: boolean;
  fetchTimeoutSec?: number;
  retries?: number;
}): string {
  const timeout = opts?.fetchTimeoutSec ?? GREENFIELD_FETCH_TIMEOUT_SEC;
  const retries = opts?.retries ?? GREENFIELD_FETCH_RETRIES;
  const reset =
    opts?.hardReset === false
      ? "git reset --soft FETCH_HEAD"
      : "git reset --hard FETCH_HEAD";
  return [
    "set -e",
    `max=${retries}`,
    "attempt=0",
    'while [ "$attempt" -lt "$max" ]; do',
    "  attempt=$((attempt + 1))",
    `  if timeout ${timeout} git fetch --depth 1 --no-tags origin main && ${reset}; then`,
    "    exit 0",
    "  fi",
    '  [ "$attempt" -lt "$max" ] && sleep 2',
    "done",
    "exit 1",
  ].join("\n");
}

/** Fetch origin/main then push local HEAD to main (greenfield single-writer). */
export function buildPushGreenfieldMainScript(opts?: {
  fetchTimeoutSec?: number;
  forceWithLease?: boolean;
  retries?: number;
}): string {
  const timeout = opts?.fetchTimeoutSec ?? GREENFIELD_FETCH_TIMEOUT_SEC;
  const retries = opts?.retries ?? GREENFIELD_FETCH_RETRIES;
  const pushCmd =
    opts?.forceWithLease === false
      ? "git push -u origin HEAD:main"
      : "git push --force-with-lease -u origin HEAD:main";
  return [
    "set -e",
    `max=${retries}`,
    "attempt=0",
    'while [ "$attempt" -lt "$max" ]; do',
    "  attempt=$((attempt + 1))",
    `  if timeout ${timeout} git fetch --depth 1 --no-tags origin main && ${pushCmd}; then`,
    "    exit 0",
    "  fi",
    '  [ "$attempt" -lt "$max" ] && sleep 2',
    "done",
    "exit 1",
  ].join("\n");
}
