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

if [[ ! -x /usr/local/bin/devin-sync-platform-config.sh ]]; then
  cat >/usr/local/bin/devin-sync-platform-config.sh <<'SCRIPT'
#!/bin/bash
set -euo pipefail
AWS_REGION="\${AWS_REGION:-${AWS_REGION}}"
SSM_PREFIX="\${SSM_PREFIX:-${SSM_PREFIX}}"

read_ssm() {
  local name="\$1"
  aws ssm get-parameter --region "\$AWS_REGION" --name "\$name" --query Parameter.Value --output text 2>/dev/null || true
}

ORCHESTRATOR_URL="\$(read_ssm "\$SSM_PREFIX/orchestrator_url")"
if [[ -z "\$ORCHESTRATOR_URL" || "\$ORCHESTRATOR_URL" == http://REPLACE_AFTER_ORCHESTRATOR_NLB:* ]]; then
  echo "Orchestrator URL not ready in SSM yet (\$SSM_PREFIX/orchestrator_url)" >&2
else
  mkdir -p /etc/systemd/system/devin-scheduler.service.d
  cat >/etc/systemd/system/devin-scheduler.service.d/orchestrator.conf <<EOF
[Service]
Environment=ORCHESTRATOR_URL=\$ORCHESTRATOR_URL
EOF
  systemctl daemon-reload
fi

if [[ -d /var/lib/devin/snapshots/nextjs ]] || [[ -d /var/lib/devin/snapshots/agent ]]; then
  systemctl enable --now devin-firecracker-host.service 2>/dev/null || true
fi

systemctl enable --now devin-scheduler.service 2>/dev/null || true
SCRIPT
  chmod +x /usr/local/bin/devin-sync-platform-config.sh
fi

AWS_REGION="${AWS_REGION}" SSM_PREFIX="${SSM_PREFIX}" /usr/local/bin/devin-sync-platform-config.sh
systemctl is-active devin-scheduler.service || systemctl status devin-scheduler.service --no-pager || true
curl -sf http://127.0.0.1:9091/health || echo "scheduler health check failed"
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
