//go:build !linux

package workspace

func ensureTmpfs(path string) error {
	return nil
}

func isTmpfs(path string) (bool, error) {
	return false, nil
}
