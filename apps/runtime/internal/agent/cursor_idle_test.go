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
