package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
)

type CursorRunner struct {
	cfg Config
}

type cursorStreamEvent struct {
	Type     string `json:"type"`
	Subtype  string `json:"subtype"`
	IsError  bool   `json:"is_error"`
	Result   string `json:"result"`
	Duration int64  `json:"duration_ms"`
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
	env := mergeEnv(req)

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
	model := envValue(req, "AGENT_MODEL")
	if model == "" {
		model = r.cfg.DefaultModel
	}
	if model == "" {
		model = "composer-2-fast"
	}
	args = append(args, "--model", model)
	args = append(args, "--workspace", workDir)
	args = append(args, req.Prompt)

	// Non-login shell + explicit PATH: guest login profiles often wipe PATH and
	// turn an absolute-or-resolved binary lookup into `agent: not found`.
	command := fmt.Sprintf(
		`export PATH="/usr/local/bin:/root/.local/bin:$PATH"; exec %s %s`,
		shellQuote(bin),
		joinShellArgs(args),
	)
	publish("agent.log", "running cursor agent", map[string]any{
		"command": command,
		"workDir": workDir,
		"model":   model,
		"bin":     bin,
	})

	var lastPublish time.Time
	var resultText string
	var gotResult bool
	var sawToolCall bool
	var durationMs int64

	result, runErr := executil.RunStreamingUntil(ctx, workDir, command, env, func(line executil.OutputLine) (bool, error) {
		if time.Since(lastPublish) >= 100*time.Millisecond || len(line.Line) >= 200 {
			lastPublish = time.Now()
			publish("agent.output", line.Line, map[string]any{
				"stream": line.Stream,
			})
		}

		var evt cursorStreamEvent
		if json.Unmarshal([]byte(line.Line), &evt) != nil {
			return false, nil
		}

		if evt.Type == "tool_call" {
			sawToolCall = true
			return false, nil
		}

		if evt.Type != "result" {
			return false, nil
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
	})
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

	// Instant "success" with no tools means the brain never touched the repo.
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
		return resolved, nil
	}

	publish("agent.log", "cursor agent CLI missing — attempting install in guest", map[string]any{
		"detail": err.Error(),
		"bin":    bin,
	})

	install := `set -e
export PATH="/usr/local/bin:/root/.local/bin:$PATH"
curl -fsSL https://cursor.com/install | bash
if [ -x /root/.local/bin/agent ]; then
  ln -sfn /root/.local/bin/agent /usr/local/bin/agent
fi
command -v agent
test -x "$(command -v agent)"
`
	installResult, installErr := executil.Run(ctx, workDir, install, env)
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
	publish("agent.log", "cursor agent CLI installed in guest", map[string]any{"bin": resolved})
	return resolved, nil
}

func whichCursorBin(ctx context.Context, workDir, bin string, env []string) (string, error) {
	script := fmt.Sprintf(
		`export PATH="/usr/local/bin:/root/.local/bin:$PATH"
if [ -x %s ]; then
  printf '%%s\n' %s
  exit 0
fi
resolved="$(command -v %s || true)"
if [ -n "$resolved" ] && [ -x "$resolved" ]; then
  printf '%%s\n' "$resolved"
  exit 0
fi
exit 1
`,
		shellQuote(bin),
		shellQuote(bin),
		shellQuote(bin),
	)
	result, err := executil.Run(ctx, workDir, script, env)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		detail := executil.CombinedOutput(result)
		if detail == "" {
			detail = fmt.Sprintf("%s not found on PATH", bin)
		}
		return "", fmt.Errorf("%s", detail)
	}
	resolved := strings.TrimSpace(result.Stdout)
	if resolved == "" {
		return "", fmt.Errorf("%s not found on PATH", bin)
	}
	// Prefer the last non-empty line (command -v output).
	lines := strings.Split(resolved, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line != "" {
			return line, nil
		}
	}
	return bin, nil
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
