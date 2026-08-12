package agent

import (
	"context"
	"fmt"
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
	cursorIdleStallLimit    = 3 * time.Minute
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

