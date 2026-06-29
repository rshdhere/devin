#!/usr/bin/env bash
# Publish scheduler URL to SSM, patch devin-server secrets, and verify from the cluster.
#
# Usage:
#   ./infra/scripts/sync-staging-scheduler-url.sh
#   SCHEDULER_URL=http://internal-xxx.elb.amazonaws.com:9091 ./infra/scripts/sync-staging-scheduler-url.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_REGION="${AWS_REGION:-ap-south-1}"
SSM_PREFIX="${SSM_PREFIX:-/devin-production/platform}"
STAGING_NAMESPACE="${STAGING_NAMESPACE:-devin-staging}"

log() { printf '%s\n' "$*"; }

resolve_scheduler_url() {
  if [[ -n "${SCHEDULER_URL:-}" ]]; then
    printf '%s' "${SCHEDULER_URL}"
    return 0
  fi

  if terraform -chdir="${ROOT}" output -raw scheduler_url >/dev/null 2>&1; then
    terraform -chdir="${ROOT}" output -raw scheduler_url
    return 0
  fi

  log "Set SCHEDULER_URL or run from a machine with terraform state for infra/" >&2
  return 1
}

verify_from_cluster() {
  local scheduler_url="$1"
  log "Verifying scheduler from ${STAGING_NAMESPACE} pod..."
  kubectl run devin-scheduler-verify --rm -i --restart=Never \
    -n "${STAGING_NAMESPACE}" --image=curlimages/curl:latest --command -- sh -c \
    "curl -sf '${scheduler_url}/health'" 2>/dev/null || {
      log "Warning: cluster pod could not reach ${scheduler_url}/health" >&2
      return 1
    }
  log "Cluster can reach scheduler at ${scheduler_url}"
}

main() {
  local scheduler_url
  scheduler_url="$(resolve_scheduler_url)"
  log "Scheduler URL: ${scheduler_url}"

  if [[ -x "${ROOT}/scripts/patch-server-scheduler-url.sh" ]]; then
    SCHEDULER_URL="${scheduler_url}" NAMESPACES="${STAGING_NAMESPACE} devin-app" \
      "${ROOT}/scripts/patch-server-scheduler-url.sh"
  fi

  local param_name="${SSM_PREFIX}/scheduler_url"
  log "Writing SSM parameter ${param_name}"
  aws ssm put-parameter \
    --region "$AWS_REGION" \
    --name "$param_name" \
    --type String \
    --value "$scheduler_url" \
    --overwrite

  if command -v kubectl >/dev/null 2>&1; then
    verify_from_cluster "$scheduler_url" || true
  fi

  log "Done. Retry a task on staging — devin-server should use SCHEDULER_URL=${scheduler_url}"
}

main "$@"
