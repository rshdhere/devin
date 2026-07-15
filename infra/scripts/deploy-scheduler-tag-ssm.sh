#!/usr/bin/env bash
set -euo pipefail
TAG="${1:?tag required}"
INSTANCE_ID="${2:-i-07232620d98d8c7fd}"
AWS_REGION="${AWS_REGION:-ap-south-1}"

REMOTE=$(cat <<EOF
bash -seu <<'E'
set -e
TAG='${TAG}'
IMG="docker.io/rshdhere/devin-scheduler:\${TAG}"
echo "Pulling \$IMG"
docker pull "\$IMG"
sed -i -E "s|docker.io/rshdhere/devin-scheduler:[^ \\\\]+|\$IMG|g" /etc/systemd/system/devin-scheduler.service
grep -oE 'devin-scheduler:[^ \\\\"]+' /etc/systemd/system/devin-scheduler.service || true
systemctl daemon-reload
systemctl restart devin-scheduler.service
sleep 4
systemctl is-active devin-scheduler.service
curl -sf http://127.0.0.1:9091/health; echo
E
EOF
)

PARAMS=$(jq -n --arg cmd "$REMOTE" '{commands:[$cmd]}')
CID=$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --timeout-seconds 600 \
  --parameters "$PARAMS" \
  --query 'Command.CommandId' \
  --output text)
echo "CommandId=$CID"
for _ in $(seq 1 60); do
  STATUS=$(aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$CID" \
    --instance-id "$INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)
  echo "status=$STATUS"
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut)
      aws ssm get-command-invocation \
        --region "$AWS_REGION" \
        --command-id "$CID" \
        --instance-id "$INSTANCE_ID" \
        --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      [[ "$STATUS" == Success ]]
      exit $?
      ;;
  esac
  sleep 5
done
echo timed out >&2
exit 1
