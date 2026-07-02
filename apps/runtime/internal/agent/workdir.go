package agent

import (
	"os"
	"path/filepath"
	"strings"
)

func resolveWorkDir(cfg Config, req RunRequest) string {
	workDir := strings.TrimSpace(req.WorkDir)
	if workDir == "" {
		repoPath := filepath.Join(cfg.Workspace, "repo")
		if isGitRepository(repoPath) {
			return repoPath
		}
		return cfg.Workspace
	}
	return filepath.Join(cfg.Workspace, filepath.Clean("/"+workDir))
}

func isGitRepository(path string) bool {
	_, err := os.Stat(filepath.Join(path, ".git"))
	return err == nil
}
