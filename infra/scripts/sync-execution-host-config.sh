#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <instance-id> [aws-region] [ssm-prefix]" >&2
  exit 1
fi

INSTANCE_ID="$1"
AWS_REGION="${2:-${AWS_REGION:-ap-south-1}}"
SSM_PREFIX="${3:-/${DEVIN_NAME_PREFIX:-devin-production}/platform}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/devin-sync-platform-config.sh"
if [[ ! -f "$SYNC_SCRIPT" ]]; then
  echo "Missing ${SYNC_SCRIPT}" >&2
  exit 1
fi

SYNC_B64="$(base64 -w0 "$SYNC_SCRIPT")"

# SSM RunShellScript uses /bin/sh unless the script starts with #!/bin/bash
COMMAND=$(cat <<EOS
#!/bin/bash
set -euo pipefail
export AWS_REGION="${AWS_REGION}"
export SSM_PREFIX="${SSM_PREFIX}"

echo '${SYNC_B64}' | base64 -d >/usr/local/bin/devin-sync-platform-config.sh
chmod +x /usr/local/bin/devin-sync-platform-config.sh

AWS_REGION="${AWS_REGION}" SSM_PREFIX="${SSM_PREFIX}" /usr/local/bin/devin-sync-platform-config.sh
systemctl is-active devin-scheduler.service || systemctl status devin-scheduler.service --no-pager || true

health_check_passed=false
for i in 1 2 3 4 5; do
  sleep 2
  if curl -sf http://127.0.0.1:9091/health >/dev/null 2>&1; then
    health_check_passed=true
    curl -sf http://127.0.0.1:9091/health
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
