package executil

import (
	"strings"
	"testing"
)

func TestGuestCommandEnvOverridesEmptyHome(t *testing.T) {
	base := []string{"HOME=/workspace/.home", "GIT_CONFIG_GLOBAL=/workspace/.home/.gitconfig"}
	got := GuestCommandEnv(base, []string{"HOME=", "GITHUB_TOKEN=secret"})
	if len(got) != 3 {
		t.Fatalf("got %v", got)
	}
	for _, entry := range got {
		if strings.HasPrefix(entry, "HOME=") && entry != "HOME=/workspace/.home" {
			t.Fatalf("unexpected HOME entry %q", entry)
		}
	}
}
