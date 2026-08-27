package vm

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPruneOrphanVMDirsKeepsActive(t *testing.T) {
	dir := t.TempDir()
	keepPath := filepath.Join(dir, "keep-me")
	dropPath := filepath.Join(dir, "drop-me")
	if err := os.MkdirAll(keepPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dropPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dropPath, "rootfs.ext4"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	removed, err := PruneOrphanVMDirs(dir, map[string]struct{}{"keep-me": {}})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed=%d want 1", removed)
	}
	if _, err := os.Stat(keepPath); err != nil {
		t.Fatalf("keep-me should remain: %v", err)
	}
	if _, err := os.Stat(dropPath); !os.IsNotExist(err) {
		t.Fatalf("drop-me should be gone: %v", err)
	}
}

func TestPruneOrphanVMDirsClearsAllWhenKeepEmpty(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	if err := os.MkdirAll(a, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(b, 0o755); err != nil {
		t.Fatal(err)
	}
	removed, err := PruneOrphanVMDirs(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Fatalf("removed=%d want 2", removed)
	}
}

func TestIsENOSPC(t *testing.T) {
	if !isENOSPC(errors.New("cp: error writing '/var/lib/devin/vms/x/rootfs.ext4': No space left on device")) {
		t.Fatal("expected ENOSPC match")
	}
	if !isENOSPC(errors.New("host disk full under /var/lib/devin/vms")) {
		t.Fatal("expected disk full match")
	}
	if isENOSPC(errors.New("permission denied")) {
		t.Fatal("did not expect ENOSPC")
	}
}
