package sysutil

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/rshdhere/devin/infra/internal/envx"
)

func Command(ctx context.Context, name string, args ...string) error {
	c := exec.CommandContext(ctx, name, args...)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	return c.Run()
}

func Download(ctx context.Context, url, to string) error {
	return Command(ctx, "curl", "-fsSL", url, "-o", to)
}

func WriteFile(name, value string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(name), 0755); err != nil {
		return err
	}
	return os.WriteFile(name, []byte(value), mode)
}

func MustRoot() error {
	if os.Geteuid() != 0 {
		return errors.New("this command must run as root")
	}
	return nil
}

func Systemctl(ctx context.Context, args ...string) error {
	return Command(ctx, "systemctl", args...)
}

func RunDir(ctx context.Context, dir, name string, args ...string) error {
	c := exec.CommandContext(ctx, name, args...)
	c.Dir = dir
	c.Env = append(os.Environ(),
		"HOME=/root",
		"GOCACHE=/root/.cache/go-build",
		"GOPATH=/root/go",
		"FIRECRACKER_BIN=/usr/local/bin/firecracker",
		"FIRECRACKER_RUNTIME_PORT=8081",
		"FIRECRACKER_SNAPSHOT_VCPU=2",
		"FIRECRACKER_SNAPSHOT_MEM_MIB=8192",
		"DEVIN_FORCE_SNAPSHOT_REBUILD="+envx.Env("DEVIN_FORCE_SNAPSHOT_REBUILD", "false"),
	)
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	return c.Run()
}

func WaitHTTP(ctx context.Context, url string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err == nil {
			res, err := http.DefaultClient.Do(req)
			if err == nil {
				res.Body.Close()
				if res.StatusCode/100 == 2 {
					return true
				}
			}
		}
		time.Sleep(2 * time.Second)
	}
	return false
}
