package executil

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

func Run(ctx context.Context, cwd, command string, env []string) (*Result, error) {
	if cwd == "" {
		cwd = "."
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, "/bin/sh", "-lc", command)
	cmd.Dir = filepath.Clean(cwd)
	cmd.Env = append(os.Environ(), env...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if ok := asExitError(err, &exitErr); ok {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() != nil {
			return nil, ctx.Err()
		} else {
			return nil, err
		}
	}

	return &Result{
		Stdout:   strings.TrimSpace(stdout.String()),
		Stderr:   strings.TrimSpace(stderr.String()),
		ExitCode: exitCode,
	}, nil
}

func RunWithTimeout(cwd, command string, env []string, timeout time.Duration) (*Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return Run(ctx, cwd, command, env)
}

func asExitError(err error, target **exec.ExitError) bool {
	if err == nil {
		return false
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		*target = exitErr
		return true
	}
	return false
}

func CombinedOutput(result *Result) string {
	if result.Stderr == "" {
		return result.Stdout
	}
	if result.Stdout == "" {
		return result.Stderr
	}
	return fmt.Sprintf("%s\n%s", result.Stdout, result.Stderr)
}
