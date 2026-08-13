package hostpayload

import (
	"encoding/base64"
	"fmt"
)

// FixGuestFilesystem stops microVMs, removes stale overlays and corrupt golden
// snapshots, then rebuilds agent/nextjs rootfs images via bootstrap-snapshots-local.
func FixGuestFilesystem(runtimes, repoRef, imageTag, registry string) string {
	if runtimes == "" {
		runtimes = "agent nextjs"
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
export DEVIN_FORCE_SNAPSHOT_REBUILD=true
export DEVIN_REPO_REF=%q
export DEVIN_CONTAINER_IMAGE_TAG=%q
export DEVIN_IMAGE_TAG=%q
export DEVIN_CONTAINER_REGISTRY=%q
echo "==== fix guest filesystem: stop services ===="
systemctl stop devin-scheduler.service 2>/dev/null || true
systemctl stop devin-firecracker.service 2>/dev/null || true
systemctl stop devin-firecracker-host.service 2>/dev/null || true
docker rm -f scheduler firecracker 2>/dev/null || true
echo "==== prune stale microVM overlays ===="
rm -rf /var/lib/devin/vms/*
find /var/lib/devin/task-snapshots -type f -delete 2>/dev/null || true
chown 1001:1001 /var/lib/devin/task-snapshots 2>/dev/null || true
echo "==== remove corrupt golden snapshots ===="
for rt in %s; do
  rm -rf "/var/lib/devin/snapshots/${rt}"
done
rm -f /var/lib/devin/.snapshots-bootstrapped
echo %q | base64 -d >/tmp/devin-fix-guest-fs
chmod 700 /tmp/devin-fix-guest-fs
exec /tmp/devin-fix-guest-fs
`, runtimes, repoRef, imageTag, imageTag, registry, runtimes, inner)
}
