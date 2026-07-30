//go:build linux

package workspace

import (
	"log/slog"
	"os"

	"golang.org/x/sys/unix"
)

// Firecracker boots this binary directly as PID 1 (init=/usr/local/bin/devin-runtime-supervisor),
// so no init system ever mounts the kernel pseudo-filesystems. The Cursor agent CLI is a bundled
// Node binary and Node blocks indefinitely during startup when /proc is absent, which surfaces as
// a task that streams no output at all until the run timeout expires.
type pseudoMount struct {
	source   string
	target   string
	fsType   string
	flags    uintptr
	data     string
	magic    int64
	required bool
}

const unixProcMagic = unix.PROC_SUPER_MAGIC

var pseudoMounts = []pseudoMount{
	{
		source:   "proc",
		target:   "/proc",
		fsType:   "proc",
		flags:    unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC,
		magic:    unix.PROC_SUPER_MAGIC,
		required: true,
	},
	{
		source: "sysfs",
		target: "/sys",
		fsType: "sysfs",
		flags:  unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC,
		magic:  unix.SYSFS_MAGIC,
	},
	{
		source: "devpts",
		target: "/dev/pts",
		fsType: "devpts",
		flags:  unix.MS_NOSUID | unix.MS_NOEXEC,
		data:   "gid=5,mode=620",
		magic:  unix.DEVPTS_SUPER_MAGIC,
	},
	{
		source: "shm",
		target: "/dev/shm",
		fsType: "tmpfs",
		flags:  unix.MS_NOSUID | unix.MS_NODEV,
		data:   "mode=1777",
		magic:  unix.TMPFS_MAGIC,
	},
	{
		source: "tmpfs",
		target: "/run",
		fsType: "tmpfs",
		flags:  unix.MS_NOSUID | unix.MS_NODEV,
		data:   "mode=755",
		magic:  unix.TMPFS_MAGIC,
	},
}

// EnsurePseudoFilesystems mounts /proc and friends when they are missing. It is
// idempotent and safe to call outside a microVM: under Docker the mounts already
// exist, and an unprivileged process simply logs the EPERM and moves on.
func EnsurePseudoFilesystems() {
	for _, mount := range pseudoMounts {
		if err := ensurePseudoMount(mount); err != nil {
			if mount.required {
				slog.Error(
					"failed to mount required pseudo-filesystem; node-based agent CLIs will hang on startup",
					"target", mount.target,
					"error", err,
				)
				continue
			}
			slog.Warn("failed to mount pseudo-filesystem", "target", mount.target, "error", err)
		}
	}
}

func ensurePseudoMount(mount pseudoMount) error {
	if isMountedAs(mount.target, mount.magic) {
		return nil
	}
	if err := os.MkdirAll(mount.target, 0o755); err != nil {
		return err
	}
	if err := unix.Mount(mount.source, mount.target, mount.fsType, mount.flags, mount.data); err != nil {
		return err
	}
	slog.Info("mounted pseudo-filesystem", "target", mount.target, "fstype", mount.fsType)
	return nil
}

func isMountedAs(path string, magic int64) bool {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return false
	}
	return int64(stat.Type) == magic
}
