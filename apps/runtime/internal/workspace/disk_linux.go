//go:build linux

package workspace

import (
	"log/slog"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

const pruneUsageThresholdPercent = 80

// EnsureBuildDirs creates isolated build/cache dirs on workspace tmpfs.
func EnsureBuildDirs(workspaceRoot string) error {
	if workspaceRoot == "" {
		workspaceRoot = defaultPath
	}
	for _, rel := range []string{
		filepath.Join(buildRootDir, "cargo-home"),
		filepath.Join(buildRootDir, "target"),
		filepath.Join(buildRootDir, "npm-cache"),
		filepath.Join(buildRootDir, "xdg-cache"),
		filepath.Join(buildRootDir, "pip-cache"),
	} {
		if err := os.MkdirAll(filepath.Join(workspaceRoot, rel), 0o755); err != nil {
			return err
		}
	}
	return nil
}

// PruneWorkspaceDiskIfLow removes heavy caches when tmpfs is nearly full.
func PruneWorkspaceDiskIfLow(workspaceRoot string) {
	if workspaceRoot == "" {
		workspaceRoot = defaultPath
	}
	usage, err := tmpfsUsagePercent(workspaceRoot)
	if err != nil {
		return
	}
	if usage < pruneUsageThresholdPercent {
		return
	}
	slog.Warn("workspace tmpfs nearly full; pruning build caches", "usagePercent", usage)
	for _, target := range pruneTargets(workspaceRoot) {
		_ = os.RemoveAll(target)
	}
}

func pruneTargets(workspaceRoot string) []string {
	home := WritableHome(workspaceRoot)
	return []string{
		filepath.Join(workspaceRoot, buildRootDir, "target"),
		filepath.Join(workspaceRoot, buildRootDir, "cargo-home", "registry", "cache"),
		filepath.Join(workspaceRoot, buildRootDir, "npm-cache"),
		filepath.Join(workspaceRoot, buildRootDir, "xdg-cache"),
		filepath.Join(workspaceRoot, buildRootDir, "pip-cache"),
		filepath.Join(workspaceRoot, "repo", "target"),
		filepath.Join(workspaceRoot, "repo", "node_modules", ".cache"),
		filepath.Join(workspaceRoot, "repo", ".next", "cache"),
		filepath.Join(home, ".cargo", "registry", "cache"),
		filepath.Join(home, ".cache", "pip"),
		filepath.Join(home, ".npm", "_cacache"),
		filepath.Join(home, ".cursor", "logs"),
	}
}

func tmpfsUsagePercent(path string) (int, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0, err
	}
	if stat.Blocks == 0 {
		return 0, nil
	}
	used := stat.Blocks - stat.Bfree
	return int(used * 100 / stat.Blocks), nil
}
