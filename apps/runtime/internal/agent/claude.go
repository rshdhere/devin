package agent

import (
	"context"
	"fmt"
	"os"

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
	if os.Getenv("ANTHROPIC_API_KEY") == "" {
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

	command := shellQuote(r.cfg.ClaudeBin) + " " + joinShellArgs(args)
	publish("agent.log", "running claude code", map[string]any{"command": command})

	result, err := executil.Run(ctx, r.cfg.Workspace, command, nil)
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
