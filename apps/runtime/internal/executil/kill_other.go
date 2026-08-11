//go:build !linux

package executil

import "os/exec"

func configureCmdProcessGroup(cmd *exec.Cmd) {}

func killCmdTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}
