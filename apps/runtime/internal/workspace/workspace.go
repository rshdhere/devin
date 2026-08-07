package workspace

import (
	"fmt"
	"os"
)

const defaultPath = "/workspace"

func DefaultPath() string {
	return defaultPath
}

func Prepare(path string) error {
	if path == "" {
		path = defaultPath
	}

	if err := os.MkdirAll(path, 0o755); err != nil {
		return fmt.Errorf("create workspace mount point: %w", err)
	}

	if err := ensureTmpfs(path); err != nil {
		return err
	}

	return EnsureWritableHome(path)
}
