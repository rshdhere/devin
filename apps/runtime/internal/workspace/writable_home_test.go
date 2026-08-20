package workspace

import (
	"strings"
	"testing"
)

func TestDevinProcessEnvPinsWritableHomeAndCargoDirs(t *testing.T) {
	env := DevinProcessEnv("/workspace")
	got := map[string]string{}
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			t.Fatalf("invalid env entry %q", entry)
		}
		got[key] = value
	}

	checks := map[string]string{
		"HOME":             "/workspace/.home",
		"CARGO_HOME":       "/workspace/.build/cargo-home",
		"CARGO_TARGET_DIR": "/workspace/.build/target",
		"RUSTUP_HOME":      "/usr/local/rustup",
	}
	for key, want := range checks {
		if got[key] != want {
			t.Fatalf("%s: got %q want %q", key, got[key], want)
		}
	}
	if !strings.Contains(got["PATH"], "/usr/local/cargo/bin") {
		t.Fatalf("PATH missing cargo bin: %q", got["PATH"])
	}
	if !strings.Contains(got["PATH"], "/usr/local/go/bin") {
		t.Fatalf("PATH missing go bin: %q", got["PATH"])
	}
}
