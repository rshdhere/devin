package vm

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCloneRootfsDoesNotMutateSource(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "golden.ext4")
	dst := filepath.Join(dir, "vm.ext4")
	if err := os.WriteFile(src, []byte("golden-rootfs"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := cloneRootfs(src, dst); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("mutated"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "golden-rootfs" {
		t.Fatalf("golden rootfs mutated: %q", got)
	}
}

func TestCloneRootfsRejectsSamePath(t *testing.T) {
	if err := cloneRootfs("/tmp/rootfs.ext4", "/tmp/rootfs.ext4"); err == nil {
		t.Fatal("expected error")
	}
}
