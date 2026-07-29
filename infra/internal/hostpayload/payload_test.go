package hostpayload

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Payloads run under `bash -e` on execution hosts, so a syntax error or a
// hard-coded "not installed" bailout breaks every deploy silently.
func TestPayloadsAreValidBashAndSelfInstalling(t *testing.T) {
	cases := map[string]string{
		"deploy":              Deploy("docker.io/example", "abc123", "ap-south-1", "/devin/production"),
		"bootstrap-snapshots": BootstrapSnapshots("agent", "true", "main", "abc123", "docker.io/example"),
		"rebootstrap":         Rebootstrap("fc-01", "docker.io/example", "abc123", "ap-south-1", "/devin/production"),
		"sync":                SyncPlatformConfig("ap-south-1", "/devin/production"),
	}

	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}

	dir := t.TempDir()
	for name, script := range cases {
		path := filepath.Join(dir, name+".sh")
		if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(bash, "-n", path).CombinedOutput(); err != nil {
			t.Errorf("%s is not valid bash: %v\n%s", name, err, out)
		}
		if strings.Contains(script, "is not installed on this host; ") {
			t.Errorf("%s still bails out instead of installing devin-infra", name)
		}
	}

	for _, name := range []string{"deploy", "rebootstrap"} {
		if !strings.Contains(cases[name], "install_devin_infra") {
			t.Errorf("%s payload does not bootstrap devin-infra", name)
		}
	}

	// bootstrap-snapshots wraps its inner script in base64; the CLI bootstrap
	// must live inside that payload, not the outer launcher.
	if strings.Contains(cases["bootstrap-snapshots"], "install_devin_infra") {
		t.Error("bootstrap-snapshots should keep the CLI bootstrap inside the encoded inner script")
	}
}

func TestEnsureCLIDefaultsAndSyntax(t *testing.T) {
	script := "#!/bin/bash\nset -euo pipefail\n" + EnsureCLI("", "", "")
	for _, want := range []string{
		"docker.io/rshdhere/devin-infra:latest",
		"--branch \"main\"",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("EnsureCLI missing %q\n%s", want, script)
		}
	}

	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	path := filepath.Join(t.TempDir(), "ensure.sh")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(bash, "-n", path).CombinedOutput(); err != nil {
		t.Fatalf("EnsureCLI is not valid bash: %v\n%s", err, out)
	}
}
