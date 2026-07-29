package hostpayload

import (
	"encoding/base64"
	"fmt"
)

// BootstrapSnapshots encodes a remote launcher for SSM AWS-RunShellScript.
// Operator-side env values are baked in (same as the old bash heredoc expansion).
func BootstrapSnapshots(runtimes, force, repoRef, imageTag, registry string) string {
	if runtimes == "" {
		runtimes = "nextjs agent node go rust python"
	}
	if force == "" {
		force = "false"
	}
	if repoRef == "" {
		repoRef = "main"
	}
	if imageTag == "" {
		imageTag = "latest"
	}
	if registry == "" {
		registry = "docker.io/rshdhere"
	}
	inner := base64.StdEncoding.EncodeToString([]byte(`#!/bin/bash
set -euo pipefail
` + EnsureCLI(registry, imageTag, repoRef) + `
exec /usr/local/bin/devin-infra bootstrap-snapshots-local
`))
	return fmt.Sprintf(`#!/bin/bash
set -euo pipefail
export DEVIN_RUNTIMES=%q
export DEVIN_FORCE_SNAPSHOT_REBUILD=%q
export DEVIN_REPO_REF=%q
export DEVIN_CONTAINER_IMAGE_TAG=%q
export DEVIN_IMAGE_TAG=%q
export DEVIN_CONTAINER_REGISTRY=%q
echo %q | base64 -d >/tmp/devin-bootstrap-snapshots
chmod 700 /tmp/devin-bootstrap-snapshots
exec /tmp/devin-bootstrap-snapshots
`, runtimes, force, repoRef, imageTag, imageTag, registry, inner)
}
