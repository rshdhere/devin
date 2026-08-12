package agent

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
)

func ensureCursorBin(
	ctx context.Context,
	cfg Config,
	req RunRequest,
	workDir string,
	env []string,
	publish func(eventType, message string, data map[string]any),
) (string, error) {
	bin := resolveCursorBin(cfg, req)
	resolved, err := whichCursorBin(ctx, workDir, bin, env)
	if err == nil {
		if verifyErr := verifyCursorBin(ctx, workDir, resolved, env); verifyErr != nil {
			return "", verifyErr
		}
		return resolved, nil
	}

	publish("agent.log", "cursor agent CLI missing — attempting install in guest", map[string]any{
		"detail": err.Error(),
		"bin":    bin,
	})

	install := `set +e
export HOME="/workspace/.home"
mkdir -p "$HOME/.local/bin" 2>/dev/null || true
export PATH="/usr/local/bin:/root/.local/bin:$HOME/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
curl https://cursor.com/install -fsS | bash
# Re-resolve after install — do not trust a single hard-coded path.
for candidate in \
  /usr/local/bin/agent \
  /root/.local/bin/agent \
  "$HOME/.local/bin/agent" \
  $(command -v agent 2>/dev/null) \
  $(ls -1 /root/.local/share/cursor-agent/versions/*/cursor-agent 2>/dev/null | sort | tail -1) \
  $(ls -1 "$HOME/.local/share/cursor-agent/versions/"*/cursor-agent 2>/dev/null | sort | tail -1)
do
  [ -n "$candidate" ] || continue
  [ -e "$candidate" ] || continue
  if [ -x "$candidate" ] || [ -L "$candidate" ]; then
    ln -sfn "$candidate" /usr/local/bin/agent
    ln -sfn "$candidate" /root/.local/bin/agent
    printf '%s\n' "$candidate"
    exit 0
  fi
done
exit 1
`
	installResult, installErr := executil.RunExact(ctx, workDir, install, env)
	if installErr != nil {
		return "", fmt.Errorf(
			"cursor agent CLI not found and install failed: %w (rebuild the agent Firecracker snapshot)",
			installErr,
		)
	}
	if installResult.ExitCode != 0 {
		detail := executil.CombinedOutput(installResult)
		if detail == "" {
			detail = fmt.Sprintf("exit %d", installResult.ExitCode)
		}
		return "", fmt.Errorf(
			"cursor agent CLI not found and install failed: %s (rebuild the agent Firecracker snapshot)",
			detail,
		)
	}

	resolved, err = whichCursorBin(ctx, workDir, "agent", env)
	if err != nil {
		return "", fmt.Errorf(
			"cursor agent CLI still missing after install: %w (rebuild the agent Firecracker snapshot)",
			err,
		)
	}
	if verifyErr := verifyCursorBin(ctx, workDir, resolved, env); verifyErr != nil {
		return "", verifyErr
	}
	publish("agent.log", "cursor agent CLI installed in guest", map[string]any{"bin": resolved})
	return resolved, nil
}

// verifyCursorBin proves the CLI can actually execute. Checking only that the file
// exists let a guest whose /proc was missing report "cursor agent CLI ready" and then
// hang for the whole run without emitting a single event.
func verifyCursorBin(ctx context.Context, workDir, bin string, env []string) error {
	script := `set +e
export HOME="/workspace/.home"
mkdir -p "$HOME/.local/bin" 2>/dev/null || true
export PATH="` + guestPathPrefix + `:$PATH"
if [ -r /proc/self/status ]; then printf 'probe:proc=mounted\n'; else printf 'probe:proc=missing\n'; fi
timeout ` + strconv.Itoa(cursorVersionTimeoutSec) + ` ` + shellQuote(bin) + ` --version 2>&1
printf 'probe:rc=%s\n' "$?"
`
	result, err := executil.RunExact(ctx, workDir, script, env)
	if err != nil {
		return fmt.Errorf("cursor agent CLI smoke test could not run: %w", err)
	}

	rc := probeValue(result.Stdout, "probe:rc=")
	procMissing := probeValue(result.Stdout, "probe:proc=") == "missing"
	detail := truncateMessage(stripProbeLines(executil.CombinedOutput(result)))

	if rc == "0" && !procMissing {
		return nil
	}
	if procMissing {
		return fmt.Errorf(
			"sandbox has no /proc mounted, so the cursor agent CLI cannot start (it is a Node binary). "+
				"Rebuild the agent Firecracker snapshot so the runtime supervisor mounts /proc. detail=%s",
			detail,
		)
	}
	if rc == "124" {
		return fmt.Errorf(
			"cursor agent CLI did not respond to --version within %ds. Rebuild the agent Firecracker snapshot. detail=%s",
			cursorVersionTimeoutSec,
			detail,
		)
	}
	return fmt.Errorf("cursor agent CLI is not runnable (exit %s). detail=%s", rc, detail)
}

func probeValue(output, prefix string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			return strings.TrimPrefix(line, prefix)
		}
	}
	return ""
}

func stripProbeLines(output string) string {
	kept := make([]string, 0, 8)
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "probe:") {
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		kept = append(kept, line)
	}
	if len(kept) == 0 {
		return "no output"
	}
	return strings.Join(kept, " | ")
}

func cursorStallLimit(req RunRequest) time.Duration {
	raw := strings.TrimSpace(envValue(req, "AGENT_STARTUP_STALL_MIN"))
	if raw == "" {
		return cursorStartupStallLimit
	}
	minutes, err := strconv.Atoi(raw)
	if err != nil || minutes < 0 {
		return cursorStartupStallLimit
	}
	return time.Duration(minutes) * time.Minute
}

func cursorIdleStallLimitFromEnv(req RunRequest) time.Duration {
	raw := strings.TrimSpace(envValue(req, "AGENT_IDLE_STALL_MIN"))
	if raw == "" {
		return cursorIdleStallLimit
	}
	minutes, err := strconv.Atoi(raw)
	if err != nil || minutes < 0 {
		return cursorIdleStallLimit
	}
	if minutes == 0 {
		return 0
	}
	return time.Duration(minutes) * time.Minute
}

func whichCursorBin(ctx context.Context, workDir, bin string, env []string) (string, error) {
	script := `set +e
export HOME="/workspace/.home"
mkdir -p "$HOME/.local/bin" 2>/dev/null || true
export PATH="/usr/local/bin:/root/.local/bin:$HOME/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
for candidate in \
  ` + shellQuote(bin) + ` \
  /usr/local/bin/agent \
  /root/.local/bin/agent \
  "$HOME/.local/bin/agent" \
  $(command -v agent 2>/dev/null) \
  $(command -v cursor-agent 2>/dev/null) \
  $(ls -1 /root/.local/share/cursor-agent/versions/*/cursor-agent 2>/dev/null | sort | tail -1) \
  $(ls -1 "$HOME/.local/share/cursor-agent/versions/"*/cursor-agent 2>/dev/null | sort | tail -1)
do
  [ -n "$candidate" ] || continue
  [ -e "$candidate" ] || continue
  if [ -x "$candidate" ] || [ -L "$candidate" ]; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done
exit 1
`
	result, err := executil.RunExact(ctx, workDir, script, env)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		detail := strings.TrimSpace(result.Stdout)
		if detail == "" {
			detail = fmt.Sprintf("%s not found on PATH", bin)
		}
		return "", fmt.Errorf("%s", detail)
	}
	resolved := strings.TrimSpace(result.Stdout)
	if resolved == "" {
		return "", fmt.Errorf("%s not found on PATH", bin)
	}
	lines := strings.Split(resolved, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line != "" {
			return line, nil
		}
	}
	return bin, nil
}

func normalizeCursorModel(model string) string {
	m := strings.TrimSpace(strings.ToLower(model))
	switch m {
	case "", "composer-2.5-fast", "composer-2-fast":
		if m == "" {
			return ""
		}
		return "composer-2.5"
	case "composer-2.5", "cursor-grok-4.5-medium":
		return m
	default:
		return "composer-2.5"
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func joinShellArgs(args []string) string {
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = shellQuote(arg)
	}
	return strings.Join(quoted, " ")
}
