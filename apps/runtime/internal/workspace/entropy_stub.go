//go:build !linux

package workspace

// EnsureEntropy is a no-op outside Linux microVM guests.
func EnsureEntropy() {}
