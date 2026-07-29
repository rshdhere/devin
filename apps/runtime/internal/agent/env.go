package agent

import (
	"os"
	"strings"
)

const guestPathPrefix = "/usr/local/bin:/root/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

func envValue(req RunRequest, key string) string {
	if req.Env != nil {
		if value := req.Env[key]; value != "" {
			return value
		}
	}
	return os.Getenv(key)
}

func mergeEnv(req RunRequest, extra ...string) []string {
	path := envValue(req, "PATH")
	if path == "" {
		path = os.Getenv("PATH")
	}
	merged := []string{
		"PATH=" + guestPathPrefix + pathSuffix(path),
	}
	merged = append(merged, extra...)
	if req.Env == nil {
		return merged
	}
	for key, value := range req.Env {
		if value == "" || strings.EqualFold(key, "PATH") {
			continue
		}
		merged = append(merged, key+"="+value)
	}
	return merged
}

func pathSuffix(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	return ":" + path
}

func resolveCursorBin(cfg Config, req RunRequest) string {
	candidates := []string{
		envValue(req, "CURSOR_AGENT_BIN"),
		cfg.CursorBin,
		"/usr/local/bin/agent",
		"/root/.local/bin/agent",
		"agent",
	}
	seen := map[string]struct{}{}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		if candidate[0] == '/' {
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
			continue
		}
		return candidate
	}
	return "agent"
}
