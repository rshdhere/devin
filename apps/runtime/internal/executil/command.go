package executil

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

type OutputLine struct {
	Stream string // "stdout" or "stderr"
	Line   string
	Time   time.Time
}

func Run(ctx context.Context, cwd, command string, env []string) (*Result, error) {
	if cwd == "" {
		cwd = "."
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	cmd.Dir = filepath.Clean(cwd)
	cmd.Env = mergeProcessEnv(env)

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

// mergeProcessEnv starts from the current process environment and applies
// overrides. Later duplicate keys replace earlier ones so callers can fix PATH.
func mergeProcessEnv(overrides []string) []string {
	envMap := make(map[string]string)
	order := make([]string, 0, 64)
	add := func(entry string) {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			return
		}
		if _, exists := envMap[key]; !exists {
			order = append(order, key)
		}
		envMap[key] = value
	}
	for _, entry := range os.Environ() {
		add(entry)
	}
	for _, entry := range overrides {
		add(entry)
	}
	out := make([]string, 0, len(order))
	for _, key := range order {
		out = append(out, key+"="+envMap[key])
	}
	return out
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

type OnOutputFunc func(line OutputLine)

// StreamLineHandler returns stop=true to terminate the process early (e.g. agent finished).
type StreamLineHandler func(line OutputLine) (stop bool, stopErr error)

func RunStreamingUntil(
	ctx context.Context,
	cwd, command string,
	env []string,
	onLine StreamLineHandler,
) (*Result, error) {
	if cwd == "" {
		cwd = "."
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	cmd.Dir = filepath.Clean(cwd)
	cmd.Env = mergeProcessEnv(env)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	var stdout, stderr bytes.Buffer
	var wg sync.WaitGroup
	stopRequested := false
	var stopErr error

	streamReader := func(pipe io.Reader, stream string, buf *bytes.Buffer) {
		defer wg.Done()
		scanner := bufio.NewScanner(pipe)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			if stopRequested {
				return
			}
			line := scanner.Text()
			buf.WriteString(line)
			buf.WriteString("\n")
			if onLine != nil {
				stop, err := onLine(OutputLine{
					Stream: stream,
					Line:   line,
					Time:   time.Now(),
				})
				if err != nil {
					stopErr = err
					stopRequested = true
					_ = cmd.Process.Kill()
					return
				}
				if stop {
					stopRequested = true
					_ = cmd.Process.Kill()
					return
				}
			}
		}
	}

	wg.Add(2)
	go streamReader(stdoutPipe, "stdout", &stdout)
	go streamReader(stderrPipe, "stderr", &stderr)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start command: %w", err)
	}

	wg.Wait()

	err = cmd.Wait()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if ok := asExitError(err, &exitErr); ok {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() != nil {
			return nil, ctx.Err()
		} else if stopRequested {
			// Process killed after successful early stop.
		} else {
			return nil, err
		}
	}

	if stopErr != nil {
		return nil, stopErr
	}

	// Early stop after a successful stream handler must not look like a crash.
	if stopRequested && exitCode != 0 {
		exitCode = 0
	}

	return &Result{
		Stdout:   strings.TrimSpace(stdout.String()),
		Stderr:   strings.TrimSpace(stderr.String()),
		ExitCode: exitCode,
	}, nil
}

func RunStreaming(ctx context.Context, cwd, command string, env []string, onOutput OnOutputFunc) (*Result, error) {
	if cwd == "" {
		cwd = "."
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	cmd.Dir = filepath.Clean(cwd)
	cmd.Env = mergeProcessEnv(env)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	var stdout, stderr bytes.Buffer
	var wg sync.WaitGroup

	streamReader := func(pipe io.Reader, stream string, buf *bytes.Buffer) {
		defer wg.Done()
		scanner := bufio.NewScanner(pipe)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			buf.WriteString(line)
			buf.WriteString("\n")
			if onOutput != nil {
				onOutput(OutputLine{
					Stream: stream,
					Line:   line,
					Time:   time.Now(),
				})
			}
		}
	}

	wg.Add(2)
	go streamReader(stdoutPipe, "stdout", &stdout)
	go streamReader(stderrPipe, "stderr", &stderr)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start command: %w", err)
	}

	wg.Wait()

	err = cmd.Wait()
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
