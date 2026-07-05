#!/usr/bin/env bash
# Apply execution host bootstrap on a running instance via SSM (skips cloud-init).
#
# Usage:
#   ./rebootstrap-execution-host.sh <instance-id> [aws-region]

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <instance-id> [aws-region]" >&2
  exit 1
fi

INSTANCE_ID="$1"
AWS_REGION="${2:-${AWS_REGION:-ap-south-1}}"

HOST_NAME="${DEVIN_HOST_NAME:-devin-production-fc-01}"
CONTAINER_REGISTRY="${DEVIN_CONTAINER_REGISTRY:-docker.io/rshdhere}"
IMAGE_TAG="${DEVIN_IMAGE_TAG:-latest}"
SSM_PREFIX="${DEVIN_SSM_PREFIX:-/devin-production/platform}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/devin-sync-platform-config.sh"
if [[ ! -f "$SYNC_SCRIPT" ]]; then
  echo "Missing ${SYNC_SCRIPT}" >&2
  exit 1
fi
SYNC_B64="$(base64 -w0 "$SYNC_SCRIPT")"

COMMAND=$(cat <<EOS
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y curl ca-certificates gnupg jq unzip

if ! command -v aws &>/dev/null; then
  tmpdir="\$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "\$tmpdir/awscliv2.zip"
  unzip -q "\$tmpdir/awscliv2.zip" -d "\$tmpdir"
  "\$tmpdir/aws/install"
  rm -rf "\$tmpdir"
fi

if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

mkdir -p /etc/cni/conf.d /opt/cni/bin /var/lib/devin/linux /var/lib/devin/snapshots /var/lib/devin/vms

cat >/etc/cni/resolv.conf <<'RESOLV'
nameserver 8.8.8.8
nameserver 1.1.1.1
nameserver 8.8.4.4
RESOLV

cat >/etc/cni/conf.d/fcnet.conflist <<'CNI'
{
  "cniVersion": "0.4.0",
  "name": "fcnet",
  "plugins": [
    {
      "type": "ptp",
      "ipMasq": true,
      "ipam": {
        "type": "host-local",
        "subnet": "192.168.127.0/24",
        "resolvConf": "/etc/cni/resolv.conf"
      }
    },
    {
      "type": "tc-redirect-tap"
    }
  ]
}
CNI

cat >/etc/sysctl.d/99-devin-microvm.conf <<'SYSCTL'
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=0
net.ipv4.conf.default.rp_filter=0
SYSCTL
sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-devin-microvm.conf

cat >/etc/systemd/system/devin-firecracker.service <<'UNIT'
[Unit]
Description=devin.baby firecracker
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStart=/usr/bin/docker run --rm --name firecracker \\
  --privileged \\
  --network host \\
  -v /dev/kvm:/dev/kvm \\
  -v /var/lib/devin:/var/lib/devin \\
  -v /etc/cni/conf.d:/etc/cni/conf.d:ro \\
  -v /opt/cni/bin:/opt/cni/bin:ro \\
  -e FIRECRACKER_DRY_RUN=false \\
  -e FIRECRACKER_HOST_PORT=9092 \\
  -e FIRECRACKER_HOST_NAME=${HOST_NAME} \\
  -e FIRECRACKER_POOL_SIZE=1 \\
  -e FIRECRACKER_DEFAULT_RUNTIME=nextjs \\
  -e FIRECRACKER_SNAPSHOT_DIR=/var/lib/devin/snapshots \\
  -e FIRECRACKER_KERNEL_PATH=/var/lib/devin/linux/vmlinux \\
  -e FIRECRACKER_VMM_DIR=/var/lib/devin/vms \\
  -e FIRECRACKER_RUNTIME_PORT=8081 \\
  -e FIRECRACKER_WARM_VCPU=1 \\
  -e FIRECRACKER_WARM_MEMORY_MIB=512 \\
  -e FIRECRACKER_CNI_NETWORK=fcnet \\
  -e FIRECRACKER_CNI_CONF_DIR=/etc/cni/conf.d \\
  -e FIRECRACKER_CNI_BIN_PATH=/opt/cni/bin \\
  -e FIRECRACKER_CAPACITY_CPU=8 \\
  -e FIRECRACKER_CAPACITY_MEMORY=16Gi \\
  ${CONTAINER_REGISTRY}/devin-firecracker:${IMAGE_TAG}
ExecStop=/usr/bin/docker stop firecracker

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/devin-scheduler.service <<'UNIT'
[Unit]
Description=devin.baby scheduler
After=devin-firecracker.service
Wants=devin-firecracker.service

[Service]
Restart=always
RestartSec=5
Environment=ORCHESTRATOR_URL=http://pending-ssm-sync:9090
ExecStart=/usr/bin/docker run --rm --name scheduler \\
  --network host \\
  -e SCHEDULER_PORT=9091 \\
  -e ORCHESTRATOR_URL=\${ORCHESTRATOR_URL} \\
  -e FIRECRACKER_HOST_URL=http://127.0.0.1:9092 \\
  -e SCHEDULER_HOST_NAME=${HOST_NAME} \\
  -e FIRECRACKER_HOST_NAME=${HOST_NAME} \\
  -e QUEUE_DRIVER=\${QUEUE_DRIVER} \\
  -e SQS_QUEUE_URL=\${SQS_QUEUE_URL} \\
  -e AWS_REGION=${AWS_REGION} \\
  -e DEFAULT_AGENT=cursor \\
  -e SANDBOX_READY_TIMEOUT_SECONDS=300 \\
  -e RUNTIME_READY_TIMEOUT_SECONDS=60 \\
  ${CONTAINER_REGISTRY}/devin-scheduler:${IMAGE_TAG}
ExecStop=/usr/bin/docker stop scheduler

[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /etc/devin
echo "${HOST_NAME}" >/etc/devin/host-name
chmod 644 /etc/devin/host-name

echo '${SYNC_B64}' | base64 -d >/usr/local/bin/devin-sync-platform-config.sh
chmod +x /usr/local/bin/devin-sync-platform-config.sh

systemctl daemon-reload
systemctl enable --now devin-platform-sync.timer 2>/dev/null || true
/usr/local/bin/devin-sync-platform-config.sh

systemctl is-active devin-scheduler.service
curl -sf http://127.0.0.1:9091/health
test -e /dev/kvm && echo "KVM ready" || echo "KVM missing — run enable-nested-virtualization.sh after IAM sync"
EOS
)

PARAMS=$(jq -n --arg cmd "$COMMAND" '{commands: [$cmd]}')

echo "Rebootstrapping ${INSTANCE_ID}..."
COMMAND_ID=$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --comment "Rebootstrap devin execution host" \
  --timeout-seconds 900 \
  --parameters "${PARAMS}" \
  --query "Command.CommandId" \
  --output text)

echo "CommandId: ${COMMAND_ID}"

for _ in $(seq 1 60); do
  STATUS=$(aws ssm get-command-invocation \
    --region "${AWS_REGION}" \
    --command-id "${COMMAND_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --query Status \
    --output text 2>/dev/null || echo Pending)

  case "${STATUS}" in
    Success)
      aws ssm get-command-invocation \
        --region "${AWS_REGION}" \
        --command-id "${COMMAND_ID}" \
        --instance-id "${INSTANCE_ID}" \
        --query '{Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      exit 0
      ;;
    Failed|Cancelled|TimedOut)
      aws ssm get-command-invocation \
        --region "${AWS_REGION}" \
        --command-id "${COMMAND_ID}" \
        --instance-id "${INSTANCE_ID}" \
        --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      exit 1
      ;;
    *)
      sleep 10
      ;;
  esac
done

echo "Timed out waiting for rebootstrap" >&2
exit 1
