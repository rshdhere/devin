//go:build linux

package workspace

import (
	"fmt"
	"log/slog"
	"os"

	"golang.org/x/sys/unix"
)

func ensureTmpfs(path string) error {
	if mounted, err := isTmpfs(path); err != nil {
		slog.Warn("unable to inspect workspace mount", "path", path, "error", err)
	} else if mounted {
		return nil
	}

	if err := unix.Mount("tmpfs", path, "tmpfs", 0, "size=4G,mode=1777"); err != nil {
		if os.IsPermission(err) || err == unix.EPERM {
			slog.Warn("tmpfs workspace mount skipped; continuing with existing directory", "path", path, "error", err)
			return nil
		}
		return fmt.Errorf("mount tmpfs workspace: %w", err)
	}

	slog.Info("mounted tmpfs workspace", "path", path)
	return nil
}

func isTmpfs(path string) (bool, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return false, err
	}
	return stat.Type == unix.TMPFS_MAGIC, nil
}
