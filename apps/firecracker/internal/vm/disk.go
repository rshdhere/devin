package vm

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const rootfsCloneHeadroomBytes = 512 * 1024 * 1024 // 512 MiB

func freeBytes(path string) (uint64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil
}

func isENOSPC(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "no space left") ||
		strings.Contains(msg, "enospc") ||
		strings.Contains(msg, "disk full")
}

// PruneOrphanVMDirs removes directories under vmmDir whose names are not in keep.
// When keep is nil or empty, every child directory is removed (cold-start cleanup).
func PruneOrphanVMDirs(vmmDir string, keep map[string]struct{}) (int, error) {
	if vmmDir == "" {
		return 0, fmt.Errorf("vmmDir is required")
	}
	entries, err := os.ReadDir(vmmDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if keep != nil {
			if _, ok := keep[name]; ok {
				continue
			}
		}
		path := filepath.Join(vmmDir, name)
		if err := os.RemoveAll(path); err != nil {
			slog.Warn("failed to prune orphan vm dir", "path", path, "error", err)
			continue
		}
		removed++
		slog.Info("pruned orphan vm dir", "path", path)
	}
	return removed, nil
}

func ensureSpaceForRootfsClone(vmmDir, rootfsSrc string, keep map[string]struct{}) error {
	info, err := os.Stat(rootfsSrc)
	if err != nil {
		return fmt.Errorf("stat golden rootfs: %w", err)
	}
	need := uint64(info.Size()) + rootfsCloneHeadroomBytes
	free, err := freeBytes(vmmDir)
	if err != nil {
		if os.IsNotExist(err) {
			if mkErr := os.MkdirAll(vmmDir, 0o755); mkErr != nil {
				return mkErr
			}
			free, err = freeBytes(vmmDir)
		}
		if err != nil {
			slog.Warn("could not measure free disk for rootfs clone", "vmmDir", vmmDir, "error", err)
			return nil
		}
	}
	if free >= need {
		return nil
	}
	slog.Warn("low host disk before rootfs clone; pruning orphan vm dirs",
		"vmmDir", vmmDir,
		"freeBytes", free,
		"needBytes", need,
	)
	removed, pruneErr := PruneOrphanVMDirs(vmmDir, keep)
	if pruneErr != nil {
		return pruneErr
	}
	free, err = freeBytes(vmmDir)
	if err != nil {
		return nil
	}
	if free < need {
		return fmt.Errorf(
			"host disk full under %s while cloning golden rootfs (free=%dMiB need~%dMiB pruned=%d): free space and retry",
			vmmDir,
			free/(1024*1024),
			need/(1024*1024),
			removed,
		)
	}
	return nil
}
