package vm

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"
)

func cloneRootfs(src, dst string) error {
	if src == "" || dst == "" {
		return fmt.Errorf("rootfs clone paths are required")
	}
	if src == dst {
		return fmt.Errorf("refusing to clone rootfs onto itself")
	}
	_ = os.Remove(dst)
	start := time.Now()
	cmd := exec.Command("cp", "--reflink=auto", "--sparse=always", src, dst)
	out, err := cmd.CombinedOutput()
	if err != nil {
		_ = os.Remove(dst)
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("copy %s -> %s: %s", src, dst, detail)
	}
	slog.Info("cloned golden rootfs for microVM",
		"src", src,
		"dst", dst,
		"elapsed", time.Since(start),
	)
	return nil
}
