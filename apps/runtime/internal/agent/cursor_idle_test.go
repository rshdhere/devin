package agent

import (
	"testing"
	"time"
)

func TestCursorIdleStallLimitDefault(t *testing.T) {
	got := cursorIdleStallLimitFromEnv(RunRequest{})
	if got != cursorIdleStallLimit {
		t.Fatalf("default idle stall = %v, want %v", got, cursorIdleStallLimit)
	}
}

func TestCursorIdleStallLimitFromEnv(t *testing.T) {
	got := cursorIdleStallLimitFromEnv(RunRequest{
		Env: map[string]string{"AGENT_IDLE_STALL_MIN": "3"},
	})
	if got != 3*time.Minute {
		t.Fatalf("idle stall = %v, want 3m", got)
	}
}

func TestCursorIdleStallLimitDisabled(t *testing.T) {
	got := cursorIdleStallLimitFromEnv(RunRequest{
		Env: map[string]string{"AGENT_IDLE_STALL_MIN": "0"},
	})
	if got != 0 {
		t.Fatalf("idle stall = %v, want 0 (disabled)", got)
	}
}

func TestCursorShellHangLimitDefault(t *testing.T) {
	got := cursorShellHangLimitFromEnv(RunRequest{})
	if got != cursorShellHangLimit {
		t.Fatalf("default shell hang = %v, want %v", got, cursorShellHangLimit)
	}
}

func TestCursorShellHangLimitFromEnv(t *testing.T) {
	got := cursorShellHangLimitFromEnv(RunRequest{
		Env: map[string]string{"AGENT_SHELL_HANG_MIN": "6"},
	})
	if got != 6*time.Minute {
		t.Fatalf("shell hang from env = %v, want 6m", got)
	}
}

func TestIsShellToolLabel(t *testing.T) {
	if !isShellToolLabel("Bash") || !isShellToolLabel("Shell") {
		t.Fatal("expected Bash/Shell to count as shell tools")
	}
	if isShellToolLabel("Read") {
		t.Fatal("Read must not count as a shell tool")
	}
}
