import { RuntimeClient, type RunResponse } from "@devin/agent-sdk";
import type { StackRuntime } from "@devin/types";
import {
  buildAlignHydratedRepoScript,
  buildPushGreenfieldMainScript,
} from "../../greenfield/git-sync.js";
import { scaffoldFilesFromDraft } from "../../greenfield/scaffold-from-draft.js";
import type { GitHubUserIdentity } from "../../github/client.js";
import {
  SANDBOX_WRITABLE_HOME,
  shellPrepareWritableHome,
} from "../../sandbox/env.js";
import {
  buildPruneWorkspaceDiskScript,
  buildSnapshotSmokeStartScript,
  buildWaitForPortScript,
  snapshotWaitSecondsForStartCommand,
} from "../../devbox/preview.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import { buildCommitMessage, escapeShell } from "./config.js";
import { smokeAndCaptureDevboxPreview } from "./desktop-capture.js";
import {
  configureSandboxGit,
  ensureGitPushAuth,
  gitRuntimeEnv,
  readGitHead,
} from "./git-operations.js";
import { probeSandboxHttps } from "./greenfield-connectivity-probes.js";
import { alignHydratedRepoWithOriginMain } from "./greenfield-provision.js";
import { ensureSandboxDns } from "./sandbox-lifecycle.js";
import { emit } from "./task-state.js";
import {
  GUEST_FS_REBUILD_HINT,
  isGuestFilesystemCorrupt,
} from "./guest-fs-corrupt.js";

const BASH_PROBE_DIR = "/workspace/.build/devin-bash-probe";

export async function ensureBashInSandbox(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
): Promise<void> {
  const probe = await runtime.terminalAllowFailure({
    taskId,
    command: [
      "set +e",
      'export PATH="/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin:/root/.local/bin:$PATH"',
      `probe_dir='${BASH_PROBE_DIR}'`,
      'mkdir -p "$probe_dir" 2>/dev/null || { echo "probe-dir-failed"; exit 1; }',
      // Drop broken / circular bash stubs before probing (self-symlink loops).
      "for stub in /usr/local/bin/bash /root/.local/bin/bash; do",
      '  if [ -L "$stub" ] && ! [ -x "$stub" ]; then rm -f "$stub"; fi',
      '  if [ -L "$stub" ]; then',
      '    resolved=$(readlink -f "$stub" 2>/dev/null || true)',
      '    if [ -z "$resolved" ] || [ "$resolved" = "$stub" ]; then rm -f "$stub"; fi',
      "  fi",
      "done",
      "bash_bin=''",
      // Prefer real system paths over anything under /usr/local/bin.
      "if [ -x /bin/bash ]; then bash_bin=/bin/bash; fi",
      'if [ -z "$bash_bin" ] && [ -x /usr/bin/bash ]; then bash_bin=/usr/bin/bash; fi',
      'if [ -z "$bash_bin" ] && command -v bash >/dev/null 2>&1; then bash_bin=$(command -v bash); fi',
      'if [ -z "$bash_bin" ] && command -v apt-get >/dev/null 2>&1; then',
      '  apt-get update -qq >"$probe_dir/devin-bash-apt.log" 2>&1',
      '  apt-get install -y -qq bash >"$probe_dir/devin-bash-apt.log" 2>&1',
      "  if [ -x /bin/bash ]; then bash_bin=/bin/bash; fi",
      '  if [ -z "$bash_bin" ] && [ -x /usr/bin/bash ]; then bash_bin=/usr/bin/bash; fi',
      '  if [ -z "$bash_bin" ]; then bash_bin=$(command -v bash); fi',
      "fi",
      'if [ -z "$bash_bin" ] || [ ! -x "$bash_bin" ]; then',
      "  echo 'bash-not-found'",
      "  exit 1",
      "fi",
      // Canonicalize so we never symlink a path onto itself.
      'bash_real=$(readlink -f "$bash_bin" 2>/dev/null || printf "%s" "$bash_bin")',
      'if [ -z "$bash_real" ] || [ ! -x "$bash_real" ]; then',
      "  echo 'bash-unresolvable'",
      "  exit 1",
      "fi",
      "mkdir -p /usr/local/bin /bin /usr/bin",
      // Old guest PATH is often just /usr/local/bin:/root/.local/bin — env bash
      // must resolve from those dirs without relying on /bin being present.
      'if [ /usr/local/bin/bash -ef "$bash_real" ] 2>/dev/null; then',
      "  :",
      'elif [ "$(readlink -f /usr/local/bin/bash 2>/dev/null)" = "$bash_real" ]; then',
      "  :",
      "else",
      '  ln -sfn "$bash_real" /usr/local/bin/bash',
      "fi",
      'if [ ! -x /bin/bash ]; then ln -sfn "$bash_real" /bin/bash; fi',
      'if [ ! -x /usr/bin/bash ]; then ln -sfn "$bash_real" /usr/bin/bash; fi',
      // Simulate legacy agent launch PATH (no /bin) — must succeed.
      // Never write probe files under /tmp: corrupt overlays often break /tmp first.
      `PATH="/usr/local/bin:/root/.local/bin" /usr/bin/env bash -c "echo ok" >"$probe_dir/devin-bash-env-ok" 2>"$probe_dir/devin-bash-env-err"`,
      "ec=$?",
      'if [ "$ec" -ne 0 ]; then',
      '  echo "env-bash-failed:$(cat "$probe_dir/devin-bash-env-err" 2>/dev/null)"',
      "  exit 1",
      "fi",
      'printf "%s\\n" "$bash_real"',
    ].join("\n"),
  });
  if (probe.exitCode !== 0) {
    const detail = (probe.stderr || probe.stdout || "").trim().slice(0, 240);
    if (isGuestFilesystemCorrupt(detail)) {
      throw new Error(
        "Sandbox guest filesystem is corrupt inside the devbox. " +
          `${detail}. ${GUEST_FS_REBUILD_HINT}`,
      );
    }
    throw new Error(
      "Sandbox has no usable bash for Cursor agent (#/usr/bin/env bash). " +
        `detail=${detail}. ` +
        "Rebuild the agent Firecracker snapshot (runtime/agent/Dockerfile).",
    );
  }
  emit(svc, "agent.log", taskId, "bash available in sandbox", {
    detail: probe.stdout.trim().slice(0, 120),
    linkedAt: "/usr/local/bin/bash",
  });
}

/**
 * Guests sometimes boot from snapshots where `agent` is missing or off PATH.
 * Prefer locating a baked-in binary. Online install is a short fallback — the
 * installer often succeeds while a naive `test -x /root/...` check still fails
 * (HOME mismatch, progress bars on stderr, --version quirks).
 */

export async function ensureCursorAgentInSandbox(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
): Promise<void> {
  const located = await findCursorAgentBinary(svc, runtime, taskId);
  if (located) {
    emit(svc, "agent.log", taskId, "cursor agent CLI ready in sandbox", {
      detail: located.slice(0, 240),
    });
    await linkCursorAgentBinary(svc, runtime, taskId, located);
    return;
  }

  const installHost = await probeSandboxHttps(
    svc,
    runtime,
    taskId,
    "https://cursor.com/",
  );
  if (!installHost.ok) {
    throw new Error(
      "cursor agent CLI is missing from the agent Firecracker snapshot, and the sandbox cannot reach cursor.com to install it" +
        ` (${installHost.detail}). Rebuild the agent snapshot on the execution host` +
        " (devin-infra rebuild-agent-snapshot <instance-id>).",
    );
  }

  emit(
    svc,
    "agent.log",
    taskId,
    "cursor agent CLI missing — attempting short online install",
    {
      cursorCom: installHost.detail,
    },
  );

  // Official installer. Do not use `set -e` across the pipe — curl progress
  // noise on stderr previously masked a successful install, and HOME may not
  // be /root inside the guest.
  const install = await runtime.terminalAllowFailure({
    taskId,
    env: gitRuntimeEnv(svc),
    command: [
      "set +e",
      shellPrepareWritableHome(),
      'export PATH="/usr/local/bin:/root/.local/bin:$HOME/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
      "curl https://cursor.com/install -fsS | bash",
      "ec=$?",
      'echo "cursor_install_exit=$ec home=$HOME"',
      'ls -la /usr/local/bin/agent /root/.local/bin/agent "$HOME/.local/bin/agent" 2>&1 | head -20',
      "ls -la /root/.local/share/cursor-agent/versions 2>&1 | tail -5",
      'ls -la "$HOME/.local/share/cursor-agent/versions" 2>&1 | tail -5',
      "exit 0",
    ].join("\n"),
  });

  const afterInstall = await findCursorAgentBinary(svc, runtime, taskId);
  if (afterInstall) {
    await linkCursorAgentBinary(svc, runtime, taskId, afterInstall);
    emit(svc, "agent.log", taskId, "cursor agent CLI installed in sandbox", {
      detail: afterInstall.slice(0, 240),
      installLog: (install.stdout || "").trim().slice(0, 300),
    });
    return;
  }

  const stdout = (install.stdout || "").trim();
  const stderr = (install.stderr || "").trim();
  // Prefer installer text over curl progress-bar spam on stderr.
  const detail =
    stdout
      .split("\n")
      .filter((line) => !/^#/.test(line.trim()) && !/^\s*[\d.]+%$/.test(line))
      .join("\n")
      .trim()
      .slice(0, 500) ||
    stderr
      .split("\n")
      .filter((line) => !line.includes("#") && !/\d+\.\d+%/.test(line))
      .join("\n")
      .trim()
      .slice(0, 400) ||
    "agent binary not found after install";

  throw new Error(
    "cursor agent CLI is not available in the sandbox after install" +
      (detail ? `: ${detail}` : "") +
      ". Rebuild the agent Firecracker snapshot" +
      " (devin-infra rebuild-agent-snapshot <instance-id>).",
  );
}

export async function findCursorAgentBinary(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
): Promise<string | null> {
  // Do not invoke --version here: a corrupted/overwritten CLI can hang forever
  // on that call (or exec-loop). Identify by resolved path + size instead.
  const findCmd = [
    "set +e",
    'if [ -z "${HOME}" ]; then export HOME=' + SANDBOX_WRITABLE_HOME + "; fi",
    'export PATH="/usr/local/bin:/root/.local/bin:$HOME/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    // The genuine cursor-agent is a ~1KB bash launcher that execs a sibling
    // node binary, so size is not a usable signal. Only reject the PATH wrapper
    // this scheduler writes, which would exec-loop back into itself.
    "is_wrapper() {",
    '  [ -f "$1" ] || return 1',
    '  grep -q "agent\\.real" "$1" 2>/dev/null',
    "}",
    "for candidate in \\",
    // Prefer versioned launchers first — PATH entries may be wrappers/symlinks.
    "  $(ls -1 /root/.local/share/cursor-agent/versions/*/cursor-agent 2>/dev/null | sort -r) \\",
    '  $(ls -1 "$HOME/.local/share/cursor-agent/versions/"*/cursor-agent 2>/dev/null | sort -r) \\',
    "  /root/.local/bin/agent.real \\",
    "  /usr/local/bin/agent \\",
    "  /root/.local/bin/agent \\",
    '  "$HOME/.local/bin/agent" \\',
    "  $(command -v agent 2>/dev/null) \\",
    "  $(command -v cursor-agent 2>/dev/null) \\",
    '  $(find /root/.local/share/cursor-agent "$HOME/.local/share/cursor-agent" \\',
    "      -type f -name cursor-agent 2>/dev/null | sort | tail -1)",
    "do",
    '  [ -n "$candidate" ] || continue',
    '  [ -e "$candidate" ] || continue',
    '  resolved=$(readlink -f "$candidate" 2>/dev/null || printf "%s" "$candidate")',
    '  [ -e "$resolved" ] || continue',
    '  if is_wrapper "$resolved"; then continue; fi',
    '  if [ -x "$resolved" ] || [ -L "$candidate" ]; then',
    '    printf "%s\\n" "$resolved"',
    "    exit 0",
    "  fi",
    "done",
    "exit 1",
  ].join("\n");

  const probe = await runtime.terminalAllowFailure({
    taskId,
    command: findCmd,
  });
  if (probe.exitCode !== 0) {
    return null;
  }
  const bin = probe.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("/") || line.includes("agent"));
  return bin || null;
}

export async function linkCursorAgentBinary(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  bin: string,
): Promise<void> {
  // Critical: /usr/local/bin/agent is often a symlink into the versioned
  // cursor-agent binary. Writing the PATH wrapper with `cat >` would follow
  // that symlink and overwrite the real CLI with a 140-byte script that
  // exec-loops forever — which is exactly the "agent running, no output"
  // failure mode. Always resolve a real non-wrapper binary first, refuse to
  // proceed if it looks like our wrapper, then replace the symlink with a
  // regular file before writing.
  await runtime.terminalAllowFailure({
    taskId,
    command: [
      "set +e",
      'export PATH="/usr/local/bin:/root/.local/bin:/usr/bin:/bin:$PATH"',
      "mkdir -p /usr/local/bin /root/.local/bin",
      `target='${escapeShell(bin)}'`,
      'if [ -z "$target" ] || [ ! -e "$target" ]; then target=$(command -v agent 2>/dev/null); fi',
      'if [ -z "$target" ] || [ ! -e "$target" ]; then exit 0; fi',
      // The genuine cursor-agent is a ~1KB bash launcher that execs a sibling
      // node binary, so size is not a usable signal. Only reject the wrapper
      // written below, which would otherwise exec-loop back into itself.
      "is_wrapper() {",
      '  [ -f "$1" ] || return 1',
      '  grep -q "agent\\.real" "$1" 2>/dev/null',
      "}",
      "resolve_real() {",
      '  candidate="$1"',
      '  [ -n "$candidate" ] || return 1',
      '  [ -e "$candidate" ] || return 1',
      '  resolved=$(readlink -f "$candidate" 2>/dev/null || printf "%s" "$candidate")',
      '  [ -e "$resolved" ] || return 1',
      '  if is_wrapper "$resolved"; then return 1; fi',
      '  printf "%s\\n" "$resolved"',
      "}",
      "real=''",
      // Prefer a previously saved pointer only if it still resolves to a
      // real binary (not the wrapper that once overwrote it).
      "if [ -e /root/.local/bin/agent.real ]; then",
      "  real=$(resolve_real /root/.local/bin/agent.real || true)",
      "fi",
      'if [ -z "$real" ]; then real=$(resolve_real "$target" || true); fi',
      'if [ -z "$real" ]; then',
      "  for candidate in \\",
      "    $(ls -1 /root/.local/share/cursor-agent/versions/*/cursor-agent 2>/dev/null | sort -r) \\",
      '    $(ls -1 "$HOME/.local/share/cursor-agent/versions/"*/cursor-agent 2>/dev/null | sort -r)',
      "  do",
      '    real=$(resolve_real "$candidate" || true)',
      '    [ -n "$real" ] && break',
      "  done",
      "fi",
      'if [ -z "$real" ] || [ ! -e "$real" ]; then',
      '  echo "linkCursorAgentBinary: no usable cursor-agent binary found" >&2',
      "  exit 1",
      "fi",
      // Point agent.real at the real binary BEFORE replacing /usr/local/bin/agent.
      'ln -sfn "$real" /root/.local/bin/agent.real',
      // Drop any symlink at the wrapper path so the write cannot follow into
      // the versioned binary and destroy it.
      "rm -f /usr/local/bin/agent",
      "cat > /usr/local/bin/agent <<'WRAP'",
      "#!/bin/sh",
      'export PATH="/usr/local/bin:/root/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"',
      'exec /root/.local/bin/agent.real "$@"',
      "WRAP",
      "chmod +x /usr/local/bin/agent",
      "ln -sfn /usr/local/bin/agent /root/.local/bin/agent",
      // Prefer real system bash; /usr/local/bin/bash may be a stub symlink.
      "bash_abs=''",
      "[ -x /bin/bash ] && bash_abs=/bin/bash",
      '[ -z "$bash_abs" ] && [ -x /usr/bin/bash ] && bash_abs=/usr/bin/bash',
      '[ -z "$bash_abs" ] && bash_abs=/bin/bash',
      'bash_abs=$(readlink -f "$bash_abs" 2>/dev/null || printf "%s" "$bash_abs")',
      'if [ -f "$real" ] && [ ! -L "$real" ]; then',
      '  first=$(head -n 1 "$real" 2>/dev/null || true)',
      '  case "$first" in',
      "  '#!/usr/bin/env bash'*)",
      '    sed -i "1s|^#!/usr/bin/env bash.*|#!${bash_abs}|" "$real" 2>/dev/null || true',
      '    chmod +x "$real" 2>/dev/null || true',
      "    ;;",
      "  esac",
      "fi",
      // Refuse to leave a wrapper that would recurse.
      'if is_wrapper "$(readlink -f /root/.local/bin/agent.real 2>/dev/null)"; then',
      '  echo "linkCursorAgentBinary: agent.real still points at a wrapper" >&2',
      "  exit 1",
      "fi",
      'PATH="/usr/local/bin:/root/.local/bin" /usr/bin/env bash -c "true" || exit 1',
      "exit 0",
    ].join("\n"),
  });
}

/**
 * Greenfield agents must leave commits or a dirty tree. Completing with only
 * the control-plane scaffold made chat apps look "done" while still stubs.
 * Compare against the pre-agent HEAD so pushes to origin/main mid-run do not
 * look like "zero progress".
 */
