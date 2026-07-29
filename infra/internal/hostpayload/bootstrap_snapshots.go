package hostpayload

import (
	"encoding/base64"
	"fmt"
)

// BootstrapSnapshots encodes a remote launcher for SSM AWS-RunShellScript.
// Operator-side env values are baked in (same as the old bash heredoc expansion).
func BootstrapSnapshots(runtimes, force, repoRef, imageTag string) string {
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
	inner := base64.StdEncoding.EncodeToString([]byte(`#!/bin/bash
set -euo pipefail
if [ -x /usr/local/bin/devin-infra ]; then
  exec /usr/local/bin/devin-infra bootstrap-snapshots-local
fi
echo "devin-infra is not installed on this host; install via userdata or install-self first" >&2
exit 1
`))
	return fmt.Sprintf(`#!/bin/bash
set -euo pipefail
export DEVIN_RUNTIMES=%q
export DEVIN_FORCE_SNAPSHOT_REBUILD=%q
export DEVIN_REPO_REF=%q
export DEVIN_CONTAINER_IMAGE_TAG=%q
export DEVIN_IMAGE_TAG=%q
echo %q | base64 -d >/tmp/devin-bootstrap-snapshots
chmod 700 /tmp/devin-bootstrap-snapshots
exec /tmp/devin-bootstrap-snapshots
`, runtimes, force, repoRef, imageTag, imageTag, inner)
}
