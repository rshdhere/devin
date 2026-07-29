package hostpayload

import "fmt"

// Deploy runs host-deploy (and platform sync) via the CLI, refreshing it first
// and clearing leftover docker container names that block systemd restarts.
func Deploy(registry, tag, region, prefix string) string {
	return fmt.Sprintf(`#!/bin/bash
set -euo pipefail
export DEVIN_CONTAINER_REGISTRY=%q DEVIN_IMAGE_TAG=%q AWS_REGION=%q DEVIN_SSM_PREFIX=%q
%s
# Clear leftover names before host-deploy — a flapping unit can hold
# /scheduler or /firecracker even after systemctl stop.
systemctl stop devin-scheduler.service 2>/dev/null || true
systemctl stop devin-firecracker.service 2>/dev/null || true
docker rm -f scheduler firecracker 2>/dev/null || true
/usr/local/bin/devin-infra host-deploy
exec /usr/local/bin/devin-infra sync-platform-config
`, registry, tag, region, prefix, EnsureCLI(registry, tag, "main"))
}
