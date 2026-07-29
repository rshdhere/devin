package hostpayload

import "fmt"

// Deploy runs host-deploy (and platform sync) via the CLI, installing it first
// when the host predates the Go CLI rollout.
func Deploy(registry, tag, region, prefix string) string {
	return fmt.Sprintf(`#!/bin/bash
set -euo pipefail
export DEVIN_CONTAINER_REGISTRY=%q DEVIN_IMAGE_TAG=%q AWS_REGION=%q DEVIN_SSM_PREFIX=%q
%s
/usr/local/bin/devin-infra host-deploy
exec /usr/local/bin/devin-infra sync-platform-config
`, registry, tag, region, prefix, EnsureCLI(registry, tag, "main"))
}
