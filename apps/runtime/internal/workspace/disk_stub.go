//go:build !linux

package workspace

func EnsureBuildDirs(workspaceRoot string) error {
	return nil
}

func PruneWorkspaceDiskIfLow(workspaceRoot string) {}
