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
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	IsError bool   `json:"is_error"`
	Result  string `json:"result"`
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

	bin := resolveCursorBin(r.cfg, req)
	whichResult, whichErr := executil.Run(
		ctx,
		workDir,
		"export PATH=\"/usr/local/bin:/root/.local/bin:$PATH\"; command -v "+shellQuote(bin)+" || test -x "+shellQuote(bin),
		mergeEnv(req),
	)
	if whichErr != nil || whichResult.ExitCode != 0 {
		message := executil.CombinedOutput(whichResult)
		if message == "" {
			message = fmt.Sprintf(
				"cursor agent CLI not found (%s). Rebuild the agent Firecracker snapshot so /usr/local/bin/agent exists.",
				bin,
			)
		}
		return &RunResult{
			Status:  "failed",
			Message: message,
			Agent:   r.Name(),
		}, nil
	}

	args := []string{
		"-p",
		"--force",
		"--trust",
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

	command := shellQuote(bin) + " " + joinShellArgs(args)
	publish("agent.log", "running cursor agent", map[string]any{
		"command":   command,
		"workDir":   workDir,
		"model":     model,
	})

	var lastPublish time.Time
	var resultText string
	var gotResult bool

	result, err := executil.RunStreamingUntil(ctx, workDir, command, mergeEnv(req), func(line executil.OutputLine) (bool, error) {
		if time.Since(lastPublish) >= 100*time.Millisecond || len(line.Line) >= 200 {
			lastPublish = time.Now()
			publish("agent.output", line.Line, map[string]any{
				"stream": line.Stream,
			})
		}

		var evt cursorStreamEvent
		if json.Unmarshal([]byte(line.Line), &evt) != nil || evt.Type != "result" {
			return false, nil
		}

		resultText = strings.TrimSpace(evt.Result)
		gotResult = true
		if evt.IsError {
			message := resultText
			if message == "" {
				message = "cursor agent returned an error result"
			}
			return true, fmt.Errorf("%s", message)
		}

		return true, nil
	})
	if err != nil {
		return nil, err
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
		return &RunResult{
			Status:  "failed",
			Message: message,
			Output:  output,
			Agent:   r.Name(),
		}, nil
	}

	publish("agent.log", "cursor agent finished", map[string]any{
		"streamResult": true,
	})

	return &RunResult{
		Status:  "completed",
		Message: "cursor agent completed task",
		Output:  resultText,
		Agent:   r.Name(),
	}, nil
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
