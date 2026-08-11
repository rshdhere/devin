package agent

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

// A healthy Cursor CLI answers --version in well under a second. Anything slower
// means the guest is broken (for example a missing /proc), and failing here turns
// a silent multi-hour hang into an actionable error.
const cursorVersionTimeoutSec = 45

// Heartbeats keep the activity feed alive while the agent is thinking, and the
// stall limits abort runs where the CLI never produces a single line (startup)
// or goes silent mid-run (hung shell HEREDOC / stuck tool).
const (
	cursorHeartbeatInterval = 30 * time.Second
	cursorWatchdogTick      = 10 * time.Second
	cursorStartupStallLimit = 5 * time.Minute
	cursorIdleStallLimit    = 8 * time.Minute
)

type CursorRunner struct {
	cfg Config
}

func (r *CursorRunner) Name() string {
	return "cursor"
}

func (r *CursorRunner) Run(
	ctx context.Context,
	req RunRequest,
	publish func(eventType, message string, data map[string]any),
) (*RunResult, error) {
	if envValue(req, "CURSOR_API_KEY") == "" {
		return &RunResult{
			Status:  "failed",
			Message: "CURSOR_API_KEY is not set",
			Agent:   r.Name(),
		}, nil
	}

	workDir := resolveWorkDir(r.cfg, req)
	env := mergeEnv(req, r.cfg.Workspace)

	bin, err := ensureCursorBin(ctx, r.cfg, req, workDir, env, publish)
	if err != nil {
		return &RunResult{
			Status:  "failed",
			Message: err.Error(),
			Agent:   r.Name(),
		}, nil
	}

	args := []string{
		"-p",
		"--force",
		"--trust",
		"--sandbox", "disabled",
		"--output-format", "stream-json",
	}
	model := normalizeCursorModel(envValue(req, "AGENT_MODEL"))
	if model == "" {
		model = normalizeCursorModel(r.cfg.DefaultModel)
	}
	if model == "" {
		model = "composer-2.5"
	}
	args = append(args, "--model", model)
	args = append(args, "--workspace", workDir)
	args = append(args, req.Prompt)

	command := fmt.Sprintf(
		`export PATH="/usr/local/bin:/root/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"; exec %s %s`,
		shellQuote(bin),
		joinShellArgs(args),
	)
	publish("agent.log", "running cursor agent", map[string]any{
		"command": command,
		"workDir": workDir,
		"model":   model,
		"bin":     bin,
	})

	var resultText string
	var gotResult bool
	var sawToolCall bool
	var durationMs int64

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	var lastOutputNano atomic.Int64
	var sawOutput atomic.Bool
	var stalled atomic.Bool
	var idleStalled atomic.Bool
	lastOutputNano.Store(time.Now().UnixNano())

	stallLimit := cursorStallLimit(req)
	idleLimit := cursorIdleStallLimitFromEnv(req)
	go func() {
		ticker := time.NewTicker(cursorWatchdogTick)
		defer ticker.Stop()
		lastBeat := time.Now()
		for {
			select {
			case <-runCtx.Done():
				return
			case now := <-ticker.C:
				idle := now.Sub(time.Unix(0, lastOutputNano.Load()))
				if !sawOutput.Load() && stallLimit > 0 && idle >= stallLimit {
					stalled.Store(true)
					cancelRun()
					return
				}
				if sawOutput.Load() && idleLimit > 0 && idle >= idleLimit {
					idleStalled.Store(true)
					cancelRun()
					return
				}
				if idle < cursorHeartbeatInterval || now.Sub(lastBeat) < cursorHeartbeatInterval {
					continue
				}
				lastBeat = now
				publish(
					"agent.log",
					fmt.Sprintf("cursor agent working — no output for %ds", int(idle.Seconds())),
					map[string]any{
						"idleSeconds": int(idle.Seconds()),
						"model":       model,
					},
				)
			}
		}
	}()

	result, runErr := executil.RunStreamingUntilGuest(runCtx, workDir, command, workspace.DevinProcessEnv(r.cfg.Workspace), envMapToSlice(req.Env), func(line executil.OutputLine) (bool, error) {
		lastOutputNano.Store(time.Now().UnixNano())
		sawOutput.Store(true)

		chunks := iterCursorJSONObjects(line.Line)
		for _, chunk := range chunks {
			evt, isStreamEvent := parseCursorEvent(chunk)
			if !isStreamEvent {
				if text := truncateMessage(chunk); text != "" {
					publish("agent.output", text, map[string]any{
						"stream": line.Stream,
					})
				}
				continue
			}

			for _, published := range summarizeCursorEvent(evt) {
				publish(published.Type, published.Message, published.Data)
			}

			if evt.Type == "tool_call" || evt.Type == "tool_use" {
				sawToolCall = true
				continue
			}
			for _, part := range evt.contentParts() {
				if part.Type == "tool_use" {
					sawToolCall = true
				}
			}

			if evt.Type != "result" {
				continue
			}

			resultText = strings.TrimSpace(evt.Result)
			gotResult = true
			durationMs = evt.Duration
			if evt.IsError {
				message := resultText
				if message == "" {
					message = "cursor agent returned an error result"
				}
				return true, fmt.Errorf("%s", message)
			}
			return true, nil
		}
		return false, nil
	})
	if stalled.Load() {
		return &RunResult{
			Status: "failed",
			Message: fmt.Sprintf(
				"cursor agent produced no output for %s after starting — the CLI never came up in the sandbox. "+
					"Rebuild the agent Firecracker snapshot (runtime/agent/Dockerfile) and verify /proc is mounted in the guest.",
				stallLimit,
			),
			Agent: r.Name(),
		}, nil
	}
	if idleStalled.Load() {
		return &RunResult{
			Status: "failed",
			Message: fmt.Sprintf(
				"cursor agent idle-stalled after %s with no output — likely hung on a shell HEREDOC or interactive git commit. "+
					"Control plane will finalize any commits already on disk.",
				idleLimit,
			),
			Agent: r.Name(),
		}, nil
	}
	if runErr != nil {
		return nil, runErr
	}

	output := executil.CombinedOutput(result)
	if result.ExitCode != 0 {
		message := strings.TrimSpace(output)
		if message == "" {
			message = fmt.Sprintf("cursor agent exited with code %d", result.ExitCode)
		}
		return &RunResult{
			Status:  "failed",
			Message: message,
			Output:  output,
			Agent:   r.Name(),
		}, nil
	}
	if !gotResult {
		message := strings.TrimSpace(output)
		if message == "" {
			message = "cursor agent finished without a result event"
		}
		if strings.Contains(strings.ToLower(message), "not found") {
			message = "cursor agent CLI failed to start: " + message
		}
		return &RunResult{
			Status:  "failed",
			Message: message,
			Output:  output,
			Agent:   r.Name(),
		}, nil
	}

	if !sawToolCall {
		return &RunResult{
			Status: "failed",
			Message: fmt.Sprintf(
				"cursor agent finished without tool calls (duration_ms=%d) — workspace was not modified",
				durationMs,
			),
			Output: output,
			Agent:  r.Name(),
		}, nil
	}

	publish("agent.log", "cursor agent finished", map[string]any{
		"streamResult": true,
		"toolCalls":    true,
		"durationMs":   durationMs,
	})

	return &RunResult{
		Status:  "completed",
		Message: "cursor agent completed task",
		Output:  resultText,
		Agent:   r.Name(),
	}, nil
}

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
