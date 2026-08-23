export const GREENFIELD_FETCH_TIMEOUT_SEC = 15;
export const GREENFIELD_FETCH_RETRIES = 3;

export function isAgentTimeoutMessage(message: string): boolean {
  return (
    /did not finish within/i.test(message) ||
    /timed out after/i.test(message) ||
    /context deadline exceeded/i.test(message) ||
    /context canceled/i.test(message) ||
    /exited with code -1/i.test(message) ||
    /idle-stalled/i.test(message) ||
    /commit-plateau/i.test(message) ||
    /shell-hung/i.test(message)
  );
}

/**
 * Agent interruptions where the control plane should finalize git work already
 * on disk instead of hard-failing and tearing down the sandbox.
 *
 * Covers scheduler timeouts / idle stalls plus Cursor cloud quota errors
 * (`RetriableError: [resource_exhausted]`) that abort mid-run after reconnects.
 */
export function isRecoverableAgentInterruption(message: string): boolean {
  if (isAgentTimeoutMessage(message)) {
    return true;
  }
  return (
    /resource_exhausted/i.test(message) ||
    /RetriableError/i.test(message) ||
    /rate.?limit(?:ed|ing)?/i.test(message) ||
    /quota.?exceeded/i.test(message)
  );
}

/** Soft-complete greenfield once enough commits land and HEAD stops moving. */
export const GREENFIELD_PLATEAU_MIN_COMMITS = 3;
/** Wait longer before soft-complete so Brain can finish a real product. */
export const GREENFIELD_PLATEAU_MS = 8 * 60 * 1000;

/** Minimum commits beyond the pre-agent HEAD for greenfield to count as done. */
export const GREENFIELD_MIN_PRODUCT_COMMITS = 3;

export function greenfieldCommitPlateauReason(commits: number): string {
  return (
    `greenfield commit-plateau: agent produced ${commits} commits with no further git progress — ` +
    "control plane will finalize"
  );
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
    // Avoid --depth 1 here — it orphans pre-agent commits and breaks
    // greenfield progress counting (rev-list base..HEAD).
    `  if timeout ${timeout} git fetch --no-tags origin main && ${pushCmd}; then`,
    "    exit 0",
    "  fi",
    '  [ "$attempt" -lt "$max" ] && sleep 2',
    "done",
    "exit 1",
  ].join("\n");
}
