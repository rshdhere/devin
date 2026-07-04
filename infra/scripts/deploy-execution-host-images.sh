#!/usr/bin/env bash
# Pull and roll devin-scheduler + devin-firecracker-host on execution host(s) via SSM.
#
# Usage:
#   ./deploy-execution-host-images.sh <instance-id> [instance-id...]
#   ./deploy-execution-host-images.sh --discover
#
# Environment:
#   AWS_REGION                 (default: ap-south-1)
#   DEVIN_IMAGE_TAG            (default: latest)
#   DEVIN_CONTAINER_REGISTRY   (default: docker.io/rshdhere)
#   DEVIN_NAME_PREFIX          (default: devin-production) — used with --discover
#   DEVIN_SSM_PREFIX           (default: /${DEVIN_NAME_PREFIX}/platform)
#   SSM_TIMEOUT_SECONDS        (default: 600)
#
# Examples:
#   DEVIN_IMAGE_TAG=abc123 ./deploy-execution-host-images.sh --discover
#   ./deploy-execution-host-images.sh i-0123456789abcdef0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AWS_REGION="${AWS_REGION:-ap-south-1}"
IMAGE_TAG="${DEVIN_IMAGE_TAG:-latest}"
REGISTRY="${DEVIN_CONTAINER_REGISTRY:-docker.io/rshdhere}"
NAME_PREFIX="${DEVIN_NAME_PREFIX:-devin-production}"
SSM_PREFIX="${DEVIN_SSM_PREFIX:-/${NAME_PREFIX}/platform}"
SSM_TIMEOUT_SECONDS="${SSM_TIMEOUT_SECONDS:-600}"

usage() {
  sed -n '2,16p' "$0"
  exit 1
}

discover_instances() {
  local output
  if ! output="$(aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --filters \
      "Name=tag:Role,Values=firecracker-execution-host" \
      "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output text 2>&1)"; then
    echo "Failed to discover execution hosts in ${AWS_REGION}: ${output}" >&2
    echo "Set EXECUTION_HOST_INSTANCE_IDS in GitHub or pass instance IDs explicitly." >&2
    return 1
  fi
  echo "$output" | tr '\t' '\n' | sed '/^$/d'
}

remote_deploy_script() {
  cat <<EOS
#!/bin/bash
set -euo pipefail

REGISTRY="${REGISTRY}"
IMAGE_TAG="${IMAGE_TAG}"
AWS_REGION="${AWS_REGION}"
SSM_PREFIX="${SSM_PREFIX}"

log() { printf '%s\n' "\$*"; }

read_execution_host_name() {
  if [[ -f /etc/devin/host-name ]]; then
    tr -d '[:space:]' </etc/devin/host-name
    return
  fi
  if [[ -f /etc/systemd/system/devin-firecracker-host.service ]]; then
    grep -oE 'FIRECRACKER_HOST_NAME=[^ \\\\]+' /etc/systemd/system/devin-firecracker-host.service 2>/dev/null \\
      | head -1 | cut -d= -f2
    return
  fi
  echo "devin-production-fc-01"
}

write_scheduler_unit() {
  local host_name
  host_name="\$(read_execution_host_name)"
  local unit="/etc/systemd/system/devin-scheduler.service"
  cat >"\$unit" <<UNIT
[Unit]
Description=devin.baby scheduler
After=devin-firecracker-host.service
Wants=devin-firecracker-host.service

[Service]
Restart=always
RestartSec=5
Environment=ORCHESTRATOR_URL=http://pending-ssm-sync:9090
ExecStart=/usr/bin/docker run --rm --name scheduler \\\\
  --network host \\\\
  --env-file /etc/devin/scheduler-secrets.env \\\\
  -e SCHEDULER_PORT=9091 \\\\
  -e ORCHESTRATOR_URL=\\\${ORCHESTRATOR_URL} \\\\
  -e FIRECRACKER_HOST_URL=http://127.0.0.1:9092 \\\\
  -e SCHEDULER_HOST_NAME=${host_name} \\\\
  -e FIRECRACKER_HOST_NAME=${host_name} \\\\
  -e QUEUE_DRIVER=\\\${QUEUE_DRIVER} \\\\
  -e SQS_QUEUE_URL=\\\${SQS_QUEUE_URL} \\\\
  -e AWS_REGION=\${AWS_REGION} \\\\
  -e DEFAULT_AGENT=cursor \\\\
  -e SANDBOX_READY_TIMEOUT_SECONDS=300 \\\\
  -e RUNTIME_READY_TIMEOUT_SECONDS=60 \\\\
  -e AGENT_RUN_TIMEOUT_MIN=30 \\\\
  -e PREVIEW_BASE_DOMAIN=3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby \\\\
  \${REGISTRY}/devin-scheduler:\${IMAGE_TAG}
ExecStop=/usr/bin/docker stop scheduler

[Install]
WantedBy=multi-user.target
UNIT
}

patch_firecracker_unit() {
  local unit="/etc/systemd/system/devin-firecracker-host.service"
  [[ -f "\$unit" ]] || return 0
  sed -i "s|\${REGISTRY}/devin-firecracker-host:[^\" ]*|\${REGISTRY}/devin-firecracker-host:\${IMAGE_TAG}|g" "\$unit"
}

log "Pulling \${REGISTRY}/devin-firecracker-host:\${IMAGE_TAG}"
docker pull "\${REGISTRY}/devin-firecracker-host:\${IMAGE_TAG}"
log "Pulling \${REGISTRY}/devin-scheduler:\${IMAGE_TAG}"
docker pull "\${REGISTRY}/devin-scheduler:\${IMAGE_TAG}"

patch_firecracker_unit
write_scheduler_unit
systemctl daemon-reload

if systemctl list-unit-files | grep -q devin-firecracker-host.service; then
  log "Restarting devin-firecracker-host"
  systemctl restart devin-firecracker-host.service
  for _ in \$(seq 1 30); do
    if curl -sf http://127.0.0.1:9092/health >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  curl -sf http://127.0.0.1:9092/health | jq . 2>/dev/null || curl -sf http://127.0.0.1:9092/health
  curl -sf http://127.0.0.1:9092/v1/status | jq . 2>/dev/null || curl -sf http://127.0.0.1:9092/v1/status
else
  log "devin-firecracker-host.service not installed — skipping"
fi

if [[ -x /usr/local/bin/devin-sync-platform-config.sh ]]; then
  AWS_REGION="\${AWS_REGION}" SSM_PREFIX="\${SSM_PREFIX}" /usr/local/bin/devin-sync-platform-config.sh
fi

if systemctl list-unit-files | grep -q devin-scheduler.service; then
  log "Restarting devin-scheduler"
  if ! systemctl restart devin-scheduler.service; then
    journalctl -u devin-scheduler.service -n 30 --no-pager >&2 || true
    exit 1
  fi
  for _ in \$(seq 1 30); do
    if curl -sf http://127.0.0.1:9091/health >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  if ! curl -sf http://127.0.0.1:9091/health; then
    journalctl -u devin-scheduler.service -n 30 --no-pager >&2 || true
    systemctl status devin-scheduler.service --no-pager >&2 || true
    exit 1
  fi
else
  log "devin-scheduler.service not installed — skipping"
fi

log "Deployed tag \${IMAGE_TAG} successfully"
EOS
}

wait_for_command() {
  local instance_id="$1"
  local command_id="$2"
  local attempts=$((SSM_TIMEOUT_SECONDS / 10))
  if (( attempts < 1 )); then
    attempts=1
  fi

  for _ in $(seq 1 "$attempts"); do
    local status
    status="$(aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$command_id" \
      --instance-id "$instance_id" \
      --query Status \
      --output text 2>/dev/null || echo Pending)"

    case "$status" in
      Success)
        aws ssm get-command-invocation \
          --region "$AWS_REGION" \
          --command-id "$command_id" \
          --instance-id "$instance_id" \
          --query '{Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
          --output json
        return 0
        ;;
      Failed|Cancelled|TimedOut)
        aws ssm get-command-invocation \
          --region "$AWS_REGION" \
          --command-id "$command_id" \
          --instance-id "$instance_id" \
          --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
          --output json
        echo "SSM deploy failed on ${instance_id}: ${status}" >&2
        return 1
        ;;
      *)
        sleep 10
        ;;
    esac
  done

  echo "Timed out waiting for SSM command ${command_id} on ${instance_id}" >&2
  return 1
}

deploy_instance() {
  local instance_id="$1"
  local remote_script
  remote_script="$(remote_deploy_script)"
  local params
  params="$(jq -n --arg cmd "$remote_script" '{commands: [$cmd]}')"

  echo "Deploying ${REGISTRY}/*:${IMAGE_TAG} to ${instance_id} (${AWS_REGION})..."
  local command_id
  command_id="$(aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$instance_id" \
    --document-name "AWS-RunShellScript" \
    --comment "Deploy devin execution host images tag ${IMAGE_TAG}" \
    --timeout-seconds "$SSM_TIMEOUT_SECONDS" \
    --parameters "$params" \
    --query "Command.CommandId" \
    --output text)"

  echo "CommandId: ${command_id}"
  wait_for_command "$instance_id" "$command_id"
}

INSTANCE_IDS=()
DISCOVER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --discover)
      DISCOVER=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    i-*)
      INSTANCE_IDS+=("$1")
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if $DISCOVER; then
  mapfile -t DISCOVERED < <(discover_instances)
  if ((${#DISCOVERED[@]} == 0)); then
    echo "No running execution hosts found (tag Role=firecracker-execution-host)" >&2
    exit 1
  fi
  INSTANCE_IDS+=("${DISCOVERED[@]}")
fi

if ((${#INSTANCE_IDS[@]} == 0)); then
  echo "Provide instance ID(s) or --discover" >&2
  usage
fi

FAILURES=0
for instance_id in "${INSTANCE_IDS[@]}"; do
  if ! deploy_instance "$instance_id"; then
    FAILURES=$((FAILURES + 1))
  fi
done

if (( FAILURES > 0 )); then
  echo "${FAILURES} host(s) failed to deploy" >&2
  exit 1
fi

echo "All execution hosts updated to ${IMAGE_TAG}"
