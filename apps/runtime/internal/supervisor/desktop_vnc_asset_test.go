package supervisor

import (
	"path/filepath"
	"strings"
	"testing"
)

func resolveDesktopVNCAssetPath(relativePath string) string {
	relative := strings.TrimPrefix(filepath.Clean("/"+relativePath), "/")
	return filepath.Join("/usr/share/novnc", relative)
}

func TestResolveDesktopVNCAssetPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		in   string
		want string
	}{
		{"core/rfb.js", "/usr/share/novnc/core/rfb.js"},
		{"/core/rfb.js", "/usr/share/novnc/core/rfb.js"},
		{"core/util/logging.js", "/usr/share/novnc/core/util/logging.js"},
	}

	for _, tc := range tests {
		got := resolveDesktopVNCAssetPath(tc.in)
		if got != tc.want {
			t.Fatalf("resolveDesktopVNCAssetPath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
