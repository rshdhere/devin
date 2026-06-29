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
        "resolvConf": "/etc/resolv.conf"
      }
    },
    {
      "type": "tc-redirect-tap"
    }
  ]
}
CNI

cat >/etc/systemd/system/devin-firecracker-host.service <<'UNIT'
[Unit]
Description=devin.baby firecracker-host
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStart=/usr/bin/docker run --rm --name firecracker-host \\
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
  ${CONTAINER_REGISTRY}/devin-firecracker-host:${IMAGE_TAG}
ExecStop=/usr/bin/docker stop firecracker-host

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/devin-scheduler.service <<'UNIT'
[Unit]
Description=devin.baby scheduler
After=devin-firecracker-host.service
Wants=devin-firecracker-host.service

[Service]
Restart=always
RestartSec=5
Environment=ORCHESTRATOR_URL=http://pending-ssm-sync:9090
ExecStart=/usr/bin/docker run --rm --name scheduler \\
  --network host \\
  -e SCHEDULER_PORT=9091 \\
  -e ORCHESTRATOR_URL=\${ORCHESTRATOR_URL} \\
  -e FIRECRACKER_HOST_URL=http://127.0.0.1:9092 \\
  -e QUEUE_DRIVER=\${QUEUE_DRIVER} \\
  -e SQS_QUEUE_URL=\${SQS_QUEUE_URL} \\
  -e AWS_REGION=${AWS_REGION} \\
  -e DEFAULT_AGENT=mock \\
  -e SANDBOX_READY_TIMEOUT_SECONDS=300 \\
  -e RUNTIME_READY_TIMEOUT_SECONDS=60 \\
  ${CONTAINER_REGISTRY}/devin-scheduler:${IMAGE_TAG}
ExecStop=/usr/bin/docker stop scheduler

[Install]
WantedBy=multi-user.target
UNIT

cat >/usr/local/bin/devin-sync-platform-config.sh <<'SYNC'
#!/bin/bash
set -euo pipefail
AWS_REGION="${AWS_REGION}"
SSM_PREFIX="${SSM_PREFIX}"

read_ssm() {
  aws ssm get-parameter --region "\$AWS_REGION" --name "\$1" --query Parameter.Value --output text 2>/dev/null || true
}

ORCHESTRATOR_URL="\$(read_ssm "\$SSM_PREFIX/orchestrator_url")"
TASK_QUEUE_URL="\$(read_ssm "\$SSM_PREFIX/task_queue_url")"
SCHEDULER_NEEDS_RESTART=0

if [[ -n "\$ORCHESTRATOR_URL" && "\$ORCHESTRATOR_URL" != http://REPLACE_AFTER_ORCHESTRATOR_NLB:* ]]; then
  mkdir -p /etc/systemd/system/devin-scheduler.service.d
  cat >/etc/systemd/system/devin-scheduler.service.d/orchestrator.conf <<EOF
[Service]
Environment=ORCHESTRATOR_URL=\$ORCHESTRATOR_URL
EOF
  SCHEDULER_NEEDS_RESTART=1
fi

if [[ -n "\$TASK_QUEUE_URL" ]]; then
  mkdir -p /etc/systemd/system/devin-scheduler.service.d
  cat >/etc/systemd/system/devin-scheduler.service.d/queue.conf <<EOF
[Service]
Environment=QUEUE_DRIVER=sqs
Environment=SQS_QUEUE_URL=\$TASK_QUEUE_URL
Environment=AWS_REGION=\$AWS_REGION
EOF
  SCHEDULER_NEEDS_RESTART=1
else
  rm -f /etc/systemd/system/devin-scheduler.service.d/queue.conf
fi

if [[ "\$SCHEDULER_NEEDS_RESTART" -eq 1 ]]; then
  systemctl daemon-reload
fi

if [[ -d /var/lib/devin/snapshots/nextjs ]] || [[ -d /var/lib/devin/snapshots/agent ]]; then
  systemctl enable --now devin-firecracker-host.service || true
fi

systemctl enable --now devin-scheduler.service || true
if [[ "\$SCHEDULER_NEEDS_RESTART" -eq 1 ]]; then
  systemctl restart devin-scheduler.service || true
fi
SYNC
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
