#!/usr/bin/env bash
set -euo pipefail

log() { echo "[fix-cni] $*"; }

log "Stopping firecracker and scheduler"
systemctl stop devin-firecracker-host.service devin-scheduler.service 2>/dev/null || true
docker stop firecracker-host scheduler 2>/dev/null || true
sleep 2

log "Flushing stale fcnet POSTROUTING rules"
while read -r line; do
  rule="${line/-A/-D}"
  # shellcheck disable=SC2086
  iptables -t nat $rule 2>/dev/null || true
done < <(iptables -t nat -S POSTROUTING | grep fcnet || true)

log "Removing stale CNI iptables chains"
while read -r chain; do
  [[ -n "$chain" ]] || continue
  iptables -t nat -F "$chain" 2>/dev/null || true
  iptables -t nat -X "$chain" 2>/dev/null || true
done < <(iptables -t nat -S | awk '/^-N CNI-/{print $2}')

log "Cleaning orphaned netns and CNI state"
for netns_path in /var/run/netns/*; do
  [[ -e "$netns_path" ]] || continue
  id=$(basename "$netns_path")
  ip netns del "$id" 2>/dev/null || rm -f "$netns_path"
done
rm -rf /var/lib/cni/networks/fcnet
find /var/lib/cni -mindepth 1 -maxdepth 1 -type d ! -name networks -exec rm -rf {} + 2>/dev/null || true

if [[ -d /var/lib/devin/snapshots/.agent-offline ]]; then
  mv /var/lib/devin/snapshots/.agent-offline /var/lib/devin/snapshots/agent
fi

cat >/etc/cni/conf.d/fcnet.conflist <<'CNI'
{
  "cniVersion": "0.4.0",
  "name": "fcnet",
  "plugins": [
    {
      "type": "ptp",
      "ipMasq": true,
      "ipam": {
        "type": "static",
        "addresses": [
          {
            "address": "192.168.127.8/24",
            "gateway": "192.168.127.1"
          }
        ],
        "routes": [
          {
            "dst": "0.0.0.0/0"
          }
        ],
        "dns": {
          "nameservers": ["8.8.8.8", "1.1.1.1", "8.8.4.4"]
        }
      }
    },
    {
      "type": "tc-redirect-tap"
    }
  ]
}
CNI

BUILD_DIR="${DEVIN_BUILD_DIR:-/opt/devin-build}"
IMAGE_TAG="${DEVIN_IMAGE_TAG:-cni-fix}"
REGISTRY="${DEVIN_CONTAINER_REGISTRY:-docker.io/rshdhere}"

log "Building ${REGISTRY}/devin-firecracker:${IMAGE_TAG} from ${BUILD_DIR}"
cd "${BUILD_DIR}"
git fetch --depth 1 origin main
git reset --hard origin/main
docker build -f apps/firecracker/Dockerfile -t "${REGISTRY}/devin-firecracker:${IMAGE_TAG}" .

UNIT=/etc/systemd/system/devin-firecracker-host.service
if [[ -f "$UNIT" ]]; then
  sed -i "s|${REGISTRY}/devin-firecracker-host:[^\" ]*|${REGISTRY}/devin-firecracker:${IMAGE_TAG}|g" "$UNIT"
  sed -i "s|${REGISTRY}/devin-firecracker:[^\" ]*|${REGISTRY}/devin-firecracker:${IMAGE_TAG}|g" "$UNIT"
  sed -i '\|-v /etc/cni/conf.d|d' "$UNIT"
  sed -i '\|-v /opt/cni/bin|d' "$UNIT"
  if ! grep -q '^ExecStartPre=' "$UNIT"; then
    sed -i '/^ExecStart=/i ExecStartPre=/bin/bash -c '"'"'rm -rf /var/lib/cni/networks/fcnet || true'"'"'' "$UNIT"
  fi
fi

systemctl daemon-reload
log "Starting firecracker"
systemctl start devin-firecracker-host.service

for _ in $(seq 1 60); do
  status="$(curl -sf http://127.0.0.1:9092/v1/status || true)"
  log "status: ${status}"
  if echo "$status" | grep -Eq '"readyVMs":[1-9]'; then
  log "Warm pool is ready"
    break
  fi
  sleep 5
done

systemctl start devin-scheduler.service
curl -sf http://127.0.0.1:9092/v1/status
curl -sf http://127.0.0.1:9091/health
log "Done"
