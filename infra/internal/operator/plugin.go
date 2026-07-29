package operator

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func InstallPlugin(ctx context.Context) error {
	if _, err := exec.LookPath("session-manager-plugin"); err == nil {
		return sysutil.Command(ctx, "session-manager-plugin", "--version")
	}
	var url string
	switch runtime.GOOS + ":" + runtime.GOARCH {
	case "linux:amd64":
		url = "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb"
	case "linux:arm64":
		url = "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_arm64/session-manager-plugin.deb"
	case "darwin:amd64":
		url = "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac/sessionmanager-bundle.zip"
	case "darwin:arm64":
		url = "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/mac_arm64/sessionmanager-bundle.zip"
	default:
		return fmt.Errorf("unsupported platform %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	dir, err := os.MkdirTemp("", "devin-ssm-plugin-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	if runtime.GOOS == "linux" {
		file := filepath.Join(dir, "plugin.deb")
		if err = sysutil.Download(ctx, url, file); err != nil {
			return err
		}
		return sysutil.Command(ctx, "sudo", "dpkg", "-i", file)
	}
	zip := filepath.Join(dir, "plugin.zip")
	if err = sysutil.Download(ctx, url, zip); err != nil {
		return err
	}
	if err = sysutil.Command(ctx, "unzip", "-q", zip, "-d", dir); err != nil {
		return err
	}
	return sysutil.Command(ctx, "sudo", filepath.Join(dir, "sessionmanager-bundle", "install"), "-i", "/usr/local/sessionmanagerplugin", "-b", "/usr/local/bin/session-manager-plugin")
}
