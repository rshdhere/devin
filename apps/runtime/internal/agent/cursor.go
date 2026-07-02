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

	workDir := resolveWorkDir(r.cfg, req)
	args = append(args, "--workspace", workDir)
	args = append(args, req.Prompt)

	command := shellQuote(r.cfg.CursorBin) + " " + joinShellArgs(args)
	publish("agent.log", "running cursor agent", map[string]any{
		"command":   command,
		"workDir":   workDir,
		"model":     model,
	})

	var lastPublish time.Time
	var resultText string

	_, err := executil.RunStreamingUntil(ctx, workDir, command, mergeEnv(req), func(line executil.OutputLine) (bool, error) {
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
