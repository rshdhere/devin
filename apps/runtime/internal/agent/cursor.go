package agent

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
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
	if os.Getenv("CURSOR_API_KEY") == "" {
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
		"--output-format", "text",
		"--workspace", r.cfg.Workspace,
	}
	if r.cfg.DefaultModel != "" {
		args = append(args, "--model", r.cfg.DefaultModel)
	}
	args = append(args, req.Prompt)

	command := shellQuote(r.cfg.CursorBin) + " " + joinShellArgs(args)
	publish("agent.log", "running cursor agent", map[string]any{"command": command})

	result, err := executil.Run(ctx, r.cfg.Workspace, command, nil)
	if err != nil {
		return nil, err
	}

	output := executil.CombinedOutput(result)
	if result.ExitCode != 0 {
		return &RunResult{
			Status:  "failed",
			Message: fmt.Sprintf("cursor agent exited with code %d", result.ExitCode),
			Output:  output,
			Agent:   r.Name(),
		}, nil
	}

	publish("agent.log", "cursor agent finished", map[string]any{
		"exitCode": result.ExitCode,
	})

	return &RunResult{
		Status:  "completed",
		Message: "cursor agent completed task",
		Output:  output,
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
