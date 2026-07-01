package agent

import (
	"context"
	"fmt"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
)

type ClaudeRunner struct {
	cfg Config
}

func (r *ClaudeRunner) Name() string {
	return "claude"
}

func (r *ClaudeRunner) Run(
	ctx context.Context,
	req RunRequest,
	publish func(eventType, message string, data map[string]any),
) (*RunResult, error) {
	if envValue(req, "ANTHROPIC_API_KEY") == "" {
		return &RunResult{
			Status:  "failed",
			Message: "ANTHROPIC_API_KEY is not set",
			Agent:   r.Name(),
		}, nil
	}

	args := []string{
		"-p",
		"--bare",
		"--allowedTools", "Bash,Read,Edit,Write,Glob,Grep",
	}
	if r.cfg.DefaultModel != "" {
		args = append(args, "--model", r.cfg.DefaultModel)
	}
	args = append(args, req.Prompt)

	workDir := resolveWorkDir(r.cfg, req)
	command := shellQuote(r.cfg.ClaudeBin) + " " + joinShellArgs(args)
	publish("agent.log", "running claude code", map[string]any{
		"command": command,
		"workDir": workDir,
	})

	var lastPublish time.Time
	onOutput := func(line executil.OutputLine) {
		if time.Since(lastPublish) < 100*time.Millisecond && len(line.Line) < 200 {
			return
		}
		lastPublish = time.Now()
		publish("agent.output", line.Line, map[string]any{
			"stream": line.Stream,
		})
	}

	result, err := executil.RunStreaming(ctx, workDir, command, mergeEnv(req), onOutput)
	if err != nil {
		return nil, err
	}

	output := executil.CombinedOutput(result)
	if result.ExitCode != 0 {
		return &RunResult{
			Status:  "failed",
			Message: fmt.Sprintf("claude code exited with code %d", result.ExitCode),
			Output:  output,
			Agent:   r.Name(),
		}, nil
	}

	publish("agent.log", "claude code finished", map[string]any{
		"exitCode": result.ExitCode,
	})

	return &RunResult{
		Status:  "completed",
		Message: "claude code completed task",
		Output:  output,
		Agent:   r.Name(),
	}, nil
}
