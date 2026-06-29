#!/usr/bin/env bash
# Rebuild only the agent Firecracker snapshot (picks up runtime supervisor changes).
#
# Usage:
#   ./rebuild-agent-snapshot.sh <instance-id> [aws-region]
#
# Required when runtime/agent code changes (e.g. per-run env injection for CURSOR_API_KEY).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <instance-id> [aws-region]" >&2
  exit 1
fi

INSTANCE_ID="$1"
AWS_REGION="${2:-${AWS_REGION:-ap-south-1}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec env \
  DEVIN_RUNTIMES=agent \
  DEVIN_FORCE_SNAPSHOT_REBUILD=true \
  "${SCRIPT_DIR}/run-ssm-bootstrap-snapshots.sh" "${INSTANCE_ID}" "${AWS_REGION}"
