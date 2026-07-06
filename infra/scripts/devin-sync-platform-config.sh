#!/bin/bash
# Sync platform secrets and scheduler wiring from AWS SSM on execution hosts.
# Installed as /usr/local/bin/devin-sync-platform-config.sh by userdata or SSM sync.
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-south-1}"
SSM_PREFIX="${SSM_PREFIX:-/devin-production/platform}"

read_ssm() {
  local name="$1"
  aws ssm get-parameter \
    --region "$AWS_REGION" \
    --name "$name" \
    --with-decryption \
    --query Parameter.Value \
    --output text 2>/dev/null || true
}

read_execution_host_name() {
  local from_ssm
  from_ssm="$(read_ssm "$SSM_PREFIX/scheduler_host_name")"
  if [[ -n "$from_ssm" ]]; then
    echo "$from_ssm"
    return
  fi
  if [[ -f /etc/devin/host-name ]]; then
    tr -d '[:space:]' </etc/devin/host-name
    return
  fi
  local fc_unit
  for fc_unit in \
    /etc/systemd/system/devin-firecracker.service \
    /etc/systemd/system/devin-firecracker-host.service; do
    if [[ -f "$fc_unit" ]]; then
      local from_unit
      from_unit="$(
        grep -oE 'FIRECRACKER_HOST_NAME=[^ \\]+' "$fc_unit" 2>/dev/null \
          | head -1 | cut -d= -f2
      )"
      if [[ -n "$from_unit" ]]; then
        echo "$from_unit"
        return
      fi
    fi
  done
  if [[ -f /etc/systemd/system/devin-scheduler.service ]]; then
    local from_scheduler
    from_scheduler="$(
      grep -oE 'SCHEDULER_HOST_NAME=[^ \\]+' \
        /etc/systemd/system/devin-scheduler.service 2>/dev/null \
        | head -1 | cut -d= -f2
    )"
    if [[ -n "$from_scheduler" ]]; then
      echo "$from_scheduler"
      return
    fi
  fi
  echo ""
}

ensure_host_name_file() {
  local name
  name="$(read_execution_host_name)"
  if [[ -z "$name" ]]; then
    echo "Could not resolve FirecrackerHost name for SCHEDULER_HOST_NAME" >&2
    return 1
  fi
  mkdir -p /etc/devin
  echo "$name" >/etc/devin/host-name
  chmod 644 /etc/devin/host-name
  echo "$name"
}

sync_scheduler_host_pinning() {
  local host_name
  host_name="$(ensure_host_name_file)" || return 0

  mkdir -p /etc/systemd/system/devin-scheduler.service.d
  cat >/etc/systemd/system/devin-scheduler.service.d/host.conf <<EOF
[Service]
Environment=SCHEDULER_HOST_NAME=${host_name}
Environment=FIRECRACKER_HOST_NAME=${host_name}
EOF

  local unit="/etc/systemd/system/devin-scheduler.service"
  if [[ -f "$unit" ]] && ! grep -q 'SCHEDULER_HOST_NAME=' "$unit"; then
    sed -i \
      "s|-e FIRECRACKER_HOST_URL=|-e SCHEDULER_HOST_NAME=${host_name} -e FIRECRACKER_HOST_NAME=${host_name} -e FIRECRACKER_HOST_URL=|" \
      "$unit" 2>/dev/null || true
  fi
}

SCHEDULER_NEEDS_RESTART=0

ORCHESTRATOR_URL="$(read_ssm "$SSM_PREFIX/orchestrator_url")"
TASK_QUEUE_URL="$(read_ssm "$SSM_PREFIX/task_queue_url")"
CURSOR_API_KEY="$(read_ssm "$SSM_PREFIX/cursor_api_key")"
ANTHROPIC_API_KEY="$(read_ssm "$SSM_PREFIX/anthropic_api_key")"
OPENAI_API_KEY="$(read_ssm "$SSM_PREFIX/openai_api_key")"
GITHUB_BOT_TOKEN="$(read_ssm "$SSM_PREFIX/github_bot_token")"
DATABASE_URL="$(read_ssm "$SSM_PREFIX/database_url")"

if [[ -z "$ORCHESTRATOR_URL" || "$ORCHESTRATOR_URL" == http://REPLACE_AFTER_ORCHESTRATOR_NLB:* ]]; then
  echo "Orchestrator URL not ready in SSM yet ($SSM_PREFIX/orchestrator_url)" >&2
else
  mkdir -p /etc/systemd/system/devin-scheduler.service.d
  cat >/etc/systemd/system/devin-scheduler.service.d/orchestrator.conf <<EOF
[Service]
Environment=ORCHESTRATOR_URL=$ORCHESTRATOR_URL
EOF
  SCHEDULER_NEEDS_RESTART=1
fi

if [[ -n "$TASK_QUEUE_URL" ]]; then
  mkdir -p /etc/systemd/system/devin-scheduler.service.d
  cat >/etc/systemd/system/devin-scheduler.service.d/queue.conf <<EOF
[Service]
Environment=QUEUE_DRIVER=sqs
Environment=SQS_QUEUE_URL=$TASK_QUEUE_URL
Environment=AWS_REGION=$AWS_REGION
EOF
  SCHEDULER_NEEDS_RESTART=1
else
  rm -f /etc/systemd/system/devin-scheduler.service.d/queue.conf
fi

HOST_NAME="$(ensure_host_name_file 2>/dev/null || true)"
sync_scheduler_host_pinning || true

mkdir -p /etc/systemd/system/devin-scheduler.service.d /etc/devin
umask 077
{
  echo "DEFAULT_AGENT=cursor"
  echo "SERVICE_MODE=worker"
  if [[ -n "$DATABASE_URL" ]]; then
    printf 'DATABASE_URL=%s\n' "${DATABASE_URL}"
  fi
  if [[ -n "$HOST_NAME" ]]; then
    echo "SCHEDULER_HOST_NAME=$HOST_NAME"
    echo "FIRECRACKER_HOST_NAME=$HOST_NAME"
  fi
  printf 'CURSOR_API_KEY=%s\n' "${CURSOR_API_KEY}"
  printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY}"
  printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY}"
  printf 'GITHUB_BOT_TOKEN=%s\n' "${GITHUB_BOT_TOKEN}"
  echo "GITHUB_BOT_NAME=baby-devin-bot"
  echo "GITHUB_BOT_EMAIL=baby-devin-bot@users.noreply.github.com"
  echo "AGENT_RUN_TIMEOUT_MIN=30"
} >/etc/devin/scheduler-secrets.env
chmod 600 /etc/devin/scheduler-secrets.env
cat >/etc/systemd/system/devin-scheduler.service.d/secrets.conf <<EOF
[Service]
EnvironmentFile=/etc/devin/scheduler-secrets.env
EOF
SCHEDULER_NEEDS_RESTART=1

if [[ "$SCHEDULER_NEEDS_RESTART" -eq 1 ]]; then
  systemctl daemon-reload
fi

if [[ -f /etc/systemd/system/devin-scheduler.service ]] \
  && ! grep -q 'devin-scheduler:' /etc/systemd/system/devin-scheduler.service; then
  echo "devin-scheduler.service ExecStart is missing image — redeploy execution host images to repair" >&2
fi

firecracker_service_unit() {
  if [[ -f /etc/systemd/system/devin-firecracker.service ]]; then
    echo "/etc/systemd/system/devin-firecracker.service"
  elif [[ -f /etc/systemd/system/devin-firecracker-host.service ]]; then
    echo "/etc/systemd/system/devin-firecracker-host.service"
  fi
}

FC_UNIT="$(firecracker_service_unit || true)"
if [[ -n "$FC_UNIT" ]] && grep -q 'FIRECRACKER_POOL_SIZE=8' "$FC_UNIT"; then
  sed -i 's/FIRECRACKER_POOL_SIZE=8/FIRECRACKER_POOL_SIZE=1/' "$FC_UNIT"
  systemctl daemon-reload
  systemctl restart "$(basename "$FC_UNIT")" 2>/dev/null || true
fi

if [[ -d /var/lib/devin/snapshots/nextjs ]] || [[ -d /var/lib/devin/snapshots/agent ]]; then
  systemctl enable --now devin-firecracker.service 2>/dev/null \
    || systemctl enable --now devin-firecracker-host.service 2>/dev/null || true
fi

systemctl enable --now devin-scheduler.service 2>/dev/null || true
if [[ "$SCHEDULER_NEEDS_RESTART" -eq 1 ]]; then
  systemctl restart devin-scheduler.service 2>/dev/null || true
fi

if curl -sf http://127.0.0.1:9091/health >/dev/null 2>&1; then
  preferred="$(curl -sf http://127.0.0.1:9091/health | jq -r '.preferredHost // empty' 2>/dev/null || true)"
  if [[ -n "$preferred" ]]; then
    echo "scheduler health ok (preferredHost=$preferred)"
  else
    echo "scheduler health ok (preferredHost not reported — redeploy scheduler image)" >&2
  fi
else
  echo "scheduler health check failed after sync" >&2
  journalctl -u devin-scheduler.service --no-pager -n 20 || true
fi

register_firecracker_host() {
  if [[ -z "${ORCHESTRATOR_URL:-}" || "$ORCHESTRATOR_URL" == http://REPLACE_AFTER_ORCHESTRATOR_NLB:* ]]; then
    return 0
  fi
  local host_name private_ip
  host_name="$(read_execution_host_name 2>/dev/null || true)"
  if [[ -z "$host_name" ]]; then
    return 0
  fi
  private_ip="$(curl -sf --max-time 2 http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null || true)"
  if [[ -z "$private_ip" ]]; then
    private_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [[ -z "$private_ip" ]]; then
    echo "could not resolve execution host private IP for FirecrackerHost registration" >&2
    return 0
  fi

  local payload
  payload="$(jq -nc \
    --arg address "http://${private_ip}:9092" \
    --arg scheduler "http://${private_ip}:9091" \
    '{spec:{address:$address,schedulerAddress:$scheduler,capacity:{cpu:8,memory:"16Gi"}}}')"

  if curl -sfS -X PUT \
    -H 'Content-Type: application/json' \
    --data "$payload" \
    "${ORCHESTRATOR_URL%/}/internal/v1/firecracker-hosts/${host_name}" >/dev/null; then
    echo "registered FirecrackerHost ${host_name} with orchestrator at ${ORCHESTRATOR_URL}"
  else
    echo "FirecrackerHost registration failed (orchestrator may need redeploy with host registry API)" >&2
  fi
}

register_firecracker_host || true
