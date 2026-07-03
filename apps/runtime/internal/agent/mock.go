package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
)

type MockRunner struct {
	cfg Config
}

func (r *MockRunner) Name() string {
	return "mock"
}

func (r *MockRunner) Run(
	ctx context.Context,
	req RunRequest,
	publish func(eventType, message string, data map[string]any),
) (*RunResult, error) {
	workDir := resolveWorkDir(r.cfg, req)

	publish("agent.log", "mock agent planning work", map[string]any{
		"prompt":  req.Prompt,
		"workDir": workDir,
	})

	readmePath := filepath.Join(workDir, "AGENT_TASK.md")
	content := fmt.Sprintf("# Task %s\n\n## Prompt\n\n%s\n\n## Plan\n\n1. Inspect workspace\n2. Apply changes\n3. Summarize result\n", req.TaskID, req.Prompt)
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(readmePath, []byte(content), 0o644); err != nil {
		return nil, err
	}
	publish("agent.tool", "wrote AGENT_TASK.md", map[string]any{"path": "AGENT_TASK.md"})

	gitInit, err := executil.Run(ctx, workDir, "git init -q", nil)
	if err != nil {
		return nil, err
	}
	if gitInit.ExitCode != 0 {
		return &RunResult{
			Status:  "failed",
			Message: "git init failed",
			Output:  executil.CombinedOutput(gitInit),
			Agent:   r.Name(),
		}, nil
	}

	commitResult, err := executil.Run(ctx, workDir, "git add AGENT_TASK.md && git commit -m 'mock agent: capture task plan'", []string{
		"GIT_AUTHOR_NAME=devin-agent",
		"GIT_AUTHOR_EMAIL=agent@devin.baby",
		"GIT_COMMITTER_NAME=devin-agent",
		"GIT_COMMITTER_EMAIL=agent@devin.baby",
	})
	if err != nil {
		return nil, err
	}

	output := strings.TrimSpace(fmt.Sprintf(
		"mock agent completed task %s\n%s",
		req.TaskID,
		executil.CombinedOutput(commitResult),
	))

	return &RunResult{
		Status:  "completed",
		Message: "mock agent completed task (set AGENT_PROVIDER=cursor or claude for real agents)",
		Output:  output,
		Agent:   r.Name(),
	}, nil
}
