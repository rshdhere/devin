package agent

import (
	"os"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

const guestPathPrefix = "/usr/local/bin:/root/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

func envValue(req RunRequest, key string) string {
	if req.Env != nil {
		if value := req.Env[key]; value != "" {
			return value
		}
	}
	return ""
}

func mergeEnv(req RunRequest, workspaceRoot string, extra ...string) []string {
	overrides := envMapToSlice(req.Env)
	if len(extra) > 0 {
		overrides = append(overrides, extra...)
	}
	return executil.GuestCommandEnv(workspace.DevinProcessEnv(workspaceRoot), overrides)
}

func envMapToSlice(env map[string]string) []string {
	if env == nil {
		return nil
	}
	out := make([]string, 0, len(env))
	for key, value := range env {
		if value == "" {
			continue
		}
		out = append(out, key+"="+value)
	}
	return out
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
