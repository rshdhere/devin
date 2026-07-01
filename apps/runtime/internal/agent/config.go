package agent

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Provider      string
	CursorBin     string
	ClaudeBin     string
	Workspace     string
	DefaultModel  string
	RunTimeoutMin int
}

func LoadConfig(workspace string) Config {
	timeout := 120
	if raw := os.Getenv("AGENT_RUN_TIMEOUT_MIN"); raw != "" {
		if value, err := parseInt(raw); err == nil && value > 0 {
			timeout = value
		}
	}

	return Config{
		Provider:      strings.TrimSpace(os.Getenv("AGENT_PROVIDER")),
		CursorBin:     envOr("CURSOR_AGENT_BIN", "agent"),
		ClaudeBin:     envOr("CLAUDE_CODE_BIN", "claude"),
		Workspace:     workspace,
		DefaultModel:  os.Getenv("AGENT_MODEL"),
		RunTimeoutMin: timeout,
	}
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func parseInt(raw string) (int, error) {
	var value int
	_, err := fmt.Sscanf(raw, "%d", &value)
	return value, err
}
