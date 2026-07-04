#!/usr/bin/env bash
# Run on the Firecracker execution host (SSH) when Terraform SSM bootstrap is unavailable.
set -euo pipefail

REGISTRY="${CONTAINER_REGISTRY:-docker.io/rshdhere}"
TAG="${IMAGE_TAG:-latest}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://REPLACE_WITH_ORCHESTRATOR_NLB:9090}"
if [[ -z "${HOST_NAME:-}" && -f /etc/devin/host-name ]]; then
  HOST_NAME="$(tr -d '[:space:]' </etc/devin/host-name)"
fi
HOST_NAME="${HOST_NAME:-devin-production-fc-01}"
mkdir -p /etc/devin
echo "$HOST_NAME" >/etc/devin/host-name

if [[ "$ORCHESTRATOR_URL" == http://REPLACE_WITH_ORCHESTRATOR_NLB:* ]]; then
  echo "Set ORCHESTRATOR_URL to the internal NLB hostname (terraform output orchestrator_url)" >&2
  exit 1
fi

mkdir -p /etc/cni/conf.d /opt/cni/bin /var/lib/devin/linux /var/lib/devin/snapshots /var/lib/devin/vms

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

cat >/etc/systemd/system/devin-scheduler.service <<UNIT
[Unit]
Description=devin.baby scheduler
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
Environment=ORCHESTRATOR_URL=${ORCHESTRATOR_URL}
ExecStart=/usr/bin/docker run --rm --name scheduler \\
  --network host \\
  -e SCHEDULER_PORT=9091 \\
  -e ORCHESTRATOR_URL=\${ORCHESTRATOR_URL} \\
  -e SCHEDULER_HOST_NAME=${HOST_NAME} \\
  -e FIRECRACKER_HOST_NAME=${HOST_NAME} \\
  -e FIRECRACKER_HOST_URL=http://127.0.0.1:9092 \\
  -e DEFAULT_AGENT=cursor \\
  -e SANDBOX_READY_TIMEOUT_SECONDS=300 \\
  -e RUNTIME_READY_TIMEOUT_SECONDS=60 \\
  ${REGISTRY}/devin-scheduler:${TAG}
ExecStop=/usr/bin/docker stop scheduler

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now devin-scheduler.service
sleep 2
curl -sf http://127.0.0.1:9091/health
echo
echo "Scheduler is running on :9091"
