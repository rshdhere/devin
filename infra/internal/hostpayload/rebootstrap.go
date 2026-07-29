package hostpayload

import "fmt"

// Rebootstrap installs host prerequisites when needed, then runs host commands.
func Rebootstrap(host, registry, tag, region, prefix string) string {
	return fmt.Sprintf(`#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export DEVIN_HOST_NAME=%q DEVIN_CONTAINER_REGISTRY=%q DEVIN_IMAGE_TAG=%q AWS_REGION=%q DEVIN_SSM_PREFIX=%q SSM_PREFIX=%q
apt-get update -y
apt-get install -y curl ca-certificates gnupg jq unzip
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
mkdir -p /etc/cni/conf.d /opt/cni/bin /var/lib/devin/linux /var/lib/devin/snapshots /var/lib/devin/vms /etc/devin
echo "$DEVIN_HOST_NAME" >/etc/devin/host-name
%s
/usr/local/bin/devin-infra fix-sandbox-dns
/usr/local/bin/devin-infra sync-platform-config
/usr/local/bin/devin-infra host-deploy
`, host, registry, tag, region, prefix, prefix, EnsureCLI(registry, tag, "main"))
}
