#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <instance-id> [aws-region] [ssm-prefix]" >&2
  exit 1
fi

INSTANCE_ID="$1"
AWS_REGION="${2:-${AWS_REGION:-ap-south-1}}"
SSM_PREFIX="${3:-/${DEVIN_NAME_PREFIX:-devin-production}/platform}"

# SSM RunShellScript uses /bin/sh unless the script starts with #!/bin/bash
COMMAND=$(cat <<EOS
#!/bin/bash
set -euo pipefail
export AWS_REGION="${AWS_REGION}"
export SSM_PREFIX="${SSM_PREFIX}"

if [[ ! -x /usr/local/bin/devin-sync-platform-config.sh ]] || ! grep -q cursor_api_key /usr/local/bin/devin-sync-platform-config.sh 2>/dev/null; then
  cat >/usr/local/bin/devin-sync-platform-config.sh <<'SCRIPT'
#!/bin/bash
set -euo pipefail
AWS_REGION="\${AWS_REGION:-${AWS_REGION}}"
SSM_PREFIX="\${SSM_PREFIX:-${SSM_PREFIX}}"

read_ssm() {
  local name="\$1"
  aws ssm get-parameter --region "\$AWS_REGION" --name "\$name" --with-decryption --query Parameter.Value --output text 2>/dev/null || true
}

ORCHESTRATOR_URL="\$(read_ssm "\$SSM_PREFIX/orchestrator_url")"
TASK_QUEUE_URL="\$(read_ssm "\$SSM_PREFIX/task_queue_url")"
CURSOR_API_KEY="\$(read_ssm "\$SSM_PREFIX/cursor_api_key")"
ANTHROPIC_API_KEY="\$(read_ssm "\$SSM_PREFIX/anthropic_api_key")"
OPENAI_API_KEY="\$(read_ssm "\$SSM_PREFIX/openai_api_key")"
GITHUB_BOT_TOKEN="\$(read_ssm "\$SSM_PREFIX/github_bot_token")"
SCHEDULER_NEEDS_RESTART=0

if [[ -z "\$ORCHESTRATOR_URL" || "\$ORCHESTRATOR_URL" == http://REPLACE_AFTER_ORCHESTRATOR_NLB:* ]]; then
  echo "Orchestrator URL not ready in SSM yet (\$SSM_PREFIX/orchestrator_url)" >&2
else
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

mkdir -p /etc/systemd/system/devin-scheduler.service.d /etc/devin
umask 077
{
  echo "DEFAULT_AGENT=cursor"
  printf 'CURSOR_API_KEY=%s\n' "\${CURSOR_API_KEY}"
  printf 'ANTHROPIC_API_KEY=%s\n' "\${ANTHROPIC_API_KEY}"
  printf 'OPENAI_API_KEY=%s\n' "\${OPENAI_API_KEY}"
  printf 'GITHUB_BOT_TOKEN=%s\n' "\${GITHUB_BOT_TOKEN}"
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

if [[ "\$SCHEDULER_NEEDS_RESTART" -eq 1 ]]; then
  systemctl daemon-reload
fi

if [[ -f /etc/systemd/system/devin-scheduler.service ]] && ! grep -q 'devin-scheduler:' /etc/systemd/system/devin-scheduler.service; then
  echo "devin-scheduler.service ExecStart is missing image — redeploy execution host images to repair" >&2
fi

if [[ -f /etc/systemd/system/devin-firecracker-host.service ]] && grep -q 'FIRECRACKER_POOL_SIZE=8' /etc/systemd/system/devin-firecracker-host.service; then
  sed -i 's/FIRECRACKER_POOL_SIZE=8/FIRECRACKER_POOL_SIZE=1/' /etc/systemd/system/devin-firecracker-host.service
  systemctl daemon-reload
  systemctl restart devin-firecracker-host.service 2>/dev/null || true
fi

if [[ -d /var/lib/devin/snapshots/nextjs ]] || [[ -d /var/lib/devin/snapshots/agent ]]; then
  systemctl enable --now devin-firecracker-host.service 2>/dev/null || true
fi

systemctl enable --now devin-scheduler.service 2>/dev/null || true
if [[ "\$SCHEDULER_NEEDS_RESTART" -eq 1 ]]; then
  systemctl restart devin-scheduler.service 2>/dev/null || true
fi
SCRIPT
  chmod +x /usr/local/bin/devin-sync-platform-config.sh
fi

AWS_REGION="${AWS_REGION}" SSM_PREFIX="${SSM_PREFIX}" /usr/local/bin/devin-sync-platform-config.sh
systemctl is-active devin-scheduler.service || systemctl status devin-scheduler.service --no-pager || true

# Health check with retry (scheduler may take a moment after restart)
health_check_passed=false
for i in 1 2 3 4 5; do
  sleep 2
  if curl -sf http://127.0.0.1:9091/health >/dev/null 2>&1; then
    health_check_passed=true
    echo "scheduler health check passed (attempt \$i)"
    break
  fi
  echo "scheduler health check attempt \$i failed, retrying..."
done

if [ "\$health_check_passed" = false ]; then
  echo "scheduler health check failed after 5 attempts"
  journalctl -u devin-scheduler.service --no-pager -n 20 || true
fi
EOS
)

PARAMS=$(jq -n --arg cmd "$COMMAND" '{commands: [$cmd]}')

aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "Sync devin platform config from SSM and verify scheduler" \
  --parameters "$PARAMS" \
  --output text \
  --query "Command.CommandId"

echo "SSM command sent to $INSTANCE_ID (region $AWS_REGION)"
