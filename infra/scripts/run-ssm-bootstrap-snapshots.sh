#!/usr/bin/env bash
# Run bootstrap-execution-host-snapshots.sh on an EC2 instance via SSM and wait for completion.
#
# Usage:
#   ./run-ssm-bootstrap-snapshots.sh <instance-id> [aws-region]

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <instance-id> [aws-region]" >&2
  exit 1
fi

INSTANCE_ID="$1"
AWS_REGION="${2:-${AWS_REGION:-ap-south-1}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP="${SCRIPT_DIR}/bootstrap-execution-host-snapshots.sh"

if [[ ! -f "${BOOTSTRAP}" ]]; then
  echo "missing ${BOOTSTRAP}" >&2
  exit 1
fi

PAYLOAD="$(base64 -w0 "${BOOTSTRAP}" 2>/dev/null || base64 "${BOOTSTRAP}" | tr -d '\n')"

COMMAND=$(cat <<EOS
#!/bin/bash
set -euo pipefail
export DEVIN_RUNTIMES="${DEVIN_RUNTIMES:-nextjs agent}"
export DEVIN_FORCE_SNAPSHOT_REBUILD="${DEVIN_FORCE_SNAPSHOT_REBUILD:-false}"
export DEVIN_REPO_REF="${DEVIN_REPO_REF:-main}"
export DEVIN_CONTAINER_IMAGE_TAG="${DEVIN_CONTAINER_IMAGE_TAG:-latest}"
echo "${PAYLOAD}" | base64 -d >/tmp/devin-bootstrap-snapshots.sh
chmod +x /tmp/devin-bootstrap-snapshots.sh
/tmp/devin-bootstrap-snapshots.sh
EOS
)

PARAMS=$(jq -n --arg cmd "$COMMAND" '{commands: [$cmd]}')

echo "Sending snapshot bootstrap to ${INSTANCE_ID} (${AWS_REGION})..."
COMMAND_ID=$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --comment "Bootstrap devin Firecracker snapshots" \
  --timeout-seconds 7200 \
  --parameters "${PARAMS}" \
  --query "Command.CommandId" \
  --output text)

echo "CommandId: ${COMMAND_ID}"

for _ in $(seq 1 240); do
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
      echo "Bootstrap succeeded."
      exit 0
      ;;
    Failed|Cancelled|TimedOut)
      aws ssm get-command-invocation \
        --region "${AWS_REGION}" \
        --command-id "${COMMAND_ID}" \
        --instance-id "${INSTANCE_ID}" \
        --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      echo "Bootstrap failed: ${STATUS}" >&2
      exit 1
      ;;
    *)
      sleep 15
      ;;
  esac
done

echo "Timed out waiting for SSM command ${COMMAND_ID}" >&2
exit 1
