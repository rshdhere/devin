#!/usr/bin/env bash
# Enable EC2 nested virtualization on a stopped execution host (C7i/M7i/C8i families).
#
# Usage:
#   ./enable-nested-virtualization.sh <instance-id> [aws-region]

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <instance-id> [aws-region]" >&2
  exit 1
fi

INSTANCE_ID="$1"
AWS_REGION="${2:-${AWS_REGION:-ap-south-1}}"

STATE=$(aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)

if [[ "${STATE}" != "stopped" ]]; then
  echo "Stopping ${INSTANCE_ID}..."
  aws ec2 stop-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" >/dev/null
  aws ec2 wait instance-stopped --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}"
fi

CORE_COUNT=$(aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].CpuOptions.CoreCount' \
  --output text)
THREADS=$(aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].CpuOptions.ThreadsPerCore' \
  --output text)

echo "Enabling nested virtualization on ${INSTANCE_ID} (${CORE_COUNT} cores, ${THREADS} threads/core)..."
aws ec2 modify-instance-cpu-options \
  --region "${AWS_REGION}" \
  --instance-id "${INSTANCE_ID}" \
  --core-count "${CORE_COUNT}" \
  --threads-per-core "${THREADS}" \
  --nested-virtualization enabled

echo "Starting ${INSTANCE_ID}..."
aws ec2 start-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" >/dev/null
aws ec2 wait instance-running --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}"
echo "Nested virtualization enabled."
