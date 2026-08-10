//go:build linux

package workspace

import (
	"log/slog"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

const buildRootDir = ".build"

// EnsureBuildDirs creates isolated cargo/rust build dirs on workspace tmpfs.
func EnsureBuildDirs(workspaceRoot string) error {
	if workspaceRoot == "" {
		workspaceRoot = defaultPath
	}
	for _, rel := range []string{
		filepath.Join(buildRootDir, "cargo-home"),
		filepath.Join(buildRootDir, "target"),
	} {
		if err := os.MkdirAll(filepath.Join(workspaceRoot, rel), 0o755); err != nil {
			return err
		}
	}
	return nil
}

// PruneWorkspaceDiskIfLow removes heavy build artifacts when tmpfs is nearly full.
func PruneWorkspaceDiskIfLow(workspaceRoot string) {
	if workspaceRoot == "" {
		workspaceRoot = defaultPath
	}
	usage, err := tmpfsUsagePercent(workspaceRoot)
	if err != nil {
		return
	}
	if usage < 88 {
		return
	}
	slog.Warn("workspace tmpfs nearly full; pruning build caches", "usagePercent", usage)
	for _, target := range []string{
		filepath.Join(workspaceRoot, buildRootDir, "target"),
		filepath.Join(workspaceRoot, buildRootDir, "cargo-home", "registry", "cache"),
		filepath.Join(workspaceRoot, "repo", "target"),
		filepath.Join(workspaceRoot, ".home", ".cargo", "registry", "cache"),
	} {
		_ = os.RemoveAll(target)
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
