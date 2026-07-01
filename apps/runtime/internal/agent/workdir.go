package agent

import (
	"path/filepath"
	"strings"
)

func resolveWorkDir(cfg Config, req RunRequest) string {
	workDir := strings.TrimSpace(req.WorkDir)
	if workDir == "" {
		return cfg.Workspace
	}
	return filepath.Join(cfg.Workspace, filepath.Clean("/"+workDir))
}
