//go:build linux

package workspace

import (
	"fmt"
	"log/slog"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

const defaultTmpfsSize = "12G"

func tmpfsMountOptions() string {
	size := strings.TrimSpace(os.Getenv("WORKSPACE_TMPFS_SIZE"))
	if size == "" {
		size = defaultTmpfsSize
	}
	return "size=" + size + ",mode=1777"
}

func ensureTmpfs(path string) error {
	opts := tmpfsMountOptions()
	if mounted, err := isTmpfs(path); err != nil {
		slog.Warn("unable to inspect workspace mount", "path", path, "error", err)
	} else if mounted {
		// Golden snapshots may ship a smaller tmpfs — grow it on every boot.
		if err := unix.Mount("tmpfs", path, "tmpfs", unix.MS_REMOUNT, opts); err != nil {
			if os.IsPermission(err) || err == unix.EPERM {
				slog.Warn("tmpfs workspace remount skipped", "path", path, "error", err)
				return nil
			}
			slog.Warn("tmpfs workspace remount failed; continuing", "path", path, "error", err)
		} else {
			slog.Info("remounted tmpfs workspace", "path", path, "options", opts)
		}
		return nil
	}

	if err := unix.Mount("tmpfs", path, "tmpfs", 0, opts); err != nil {
		if os.IsPermission(err) || err == unix.EPERM {
			slog.Warn("tmpfs workspace mount skipped; continuing with existing directory", "path", path, "error", err)
			return nil
		}
		return fmt.Errorf("mount tmpfs workspace: %w", err)
	}

	slog.Info("mounted tmpfs workspace", "path", path, "options", opts)
	return nil
}

func isTmpfs(path string) (bool, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return false, err
	}
	return stat.Type == unix.TMPFS_MAGIC, nil
}
