//go:build linux

package workspace

import "testing"

// The magic numbers gate the idempotency check. If one is wrong the supervisor
// would stack a second mount over an already-mounted filesystem on every boot.
func TestPseudoMountMagicMatchesLiveMounts(t *testing.T) {
	for _, mount := range pseudoMounts {
		if mount.target != "/proc" && mount.target != "/sys" {
			// Only /proc and /sys are guaranteed present in every build sandbox.
			continue
		}
		if !isMountedAs(mount.target, mount.magic) {
			t.Errorf("%s is mounted but magic 0x%x did not match", mount.target, mount.magic)
		}
	}
}

func TestEnsurePseudoFilesystemsIsIdempotent(t *testing.T) {
	EnsurePseudoFilesystems()
	if !isMountedAs("/proc", unixProcMagic) {
		t.Fatal("/proc should still be mounted after ensure")
	}
}
