package workspace

import (
	"fmt"
	"os"
	"path/filepath"
)

// WritableHomeDir lives on workspace tmpfs — the golden rootfs is read-only at restore.
const WritableHomeDir = ".home"

func WritableHome(workspaceRoot string) string {
	if workspaceRoot == "" {
		workspaceRoot = defaultPath
	}
	return filepath.Join(workspaceRoot, WritableHomeDir)
}

func GitConfigPath(workspaceRoot string) string {
	return filepath.Join(WritableHome(workspaceRoot), ".gitconfig")
}

// DevinProcessEnv returns env vars every guest shell should use for git and CLIs.
func DevinProcessEnv(workspaceRoot string) []string {
	home := WritableHome(workspaceRoot)
	buildRoot := filepath.Join(workspaceRoot, buildRootDir)
	return []string{
		"HOME=" + home,
		"GIT_CONFIG_GLOBAL=" + GitConfigPath(workspaceRoot),
		"GIT_EDITOR=true",
		"GIT_TERMINAL_PROMPT=0",
		"EDITOR=true",
		"VISUAL=true",
		"PAGER=cat",
		"PIP_NO_CACHE_DIR=1",
		"PIP_DISABLE_PIP_VERSION_CHECK=1",
		"npm_config_cache=" + filepath.Join(buildRoot, "npm-cache"),
		"XDG_CACHE_HOME=" + filepath.Join(buildRoot, "xdg-cache"),
		"CARGO_HOME=" + filepath.Join(buildRoot, "cargo-home"),
		"CARGO_TARGET_DIR=" + filepath.Join(buildRoot, "target"),
		"RUSTUP_HOME=" + filepath.Join(buildRoot, "rustup"),
		"PATH=/usr/local/bin:/root/.local/bin:" + filepath.Join(home, ".local/bin") +
			":/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
	}
}

// EnsureWritableHome creates the writable home tree and clears stale git locks.
func EnsureWritableHome(workspaceRoot string) error {
	home := WritableHome(workspaceRoot)
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("create writable home: %w", err)
	}
	for _, rel := range []string{".cursor", ".devin/githooks", ".local/bin"} {
		if err := os.MkdirAll(filepath.Join(home, rel), 0o755); err != nil {
			return fmt.Errorf("create %s: %w", rel, err)
		}
	}
	_ = os.Remove(filepath.Join(home, ".gitconfig.lock"))
	return nil
}
