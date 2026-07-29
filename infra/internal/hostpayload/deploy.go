package hostpayload

import "fmt"

// Deploy runs host-deploy (and platform sync) via the installed CLI.
func Deploy(registry, tag, region, prefix string) string {
	return fmt.Sprintf(`#!/bin/bash
set -euo pipefail
export DEVIN_CONTAINER_REGISTRY=%q DEVIN_IMAGE_TAG=%q AWS_REGION=%q DEVIN_SSM_PREFIX=%q
if [ -x /usr/local/bin/devin-infra ]; then
  /usr/local/bin/devin-infra host-deploy
  exec /usr/local/bin/devin-infra sync-platform-config
fi
echo "devin-infra is not installed on this host" >&2
exit 1
`, registry, tag, region, prefix)
}
