#!/usr/bin/env bash
# Apply FirecrackerHost CRs to the cluster (Path B external execution hosts).
#
# Usage:
#   kubectl apply -f infra/generated/firecracker-hosts.yaml
#   ./infra/scripts/apply-firecracker-hosts.sh [path-to-yaml]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MANIFEST="${1:-${REPO_ROOT}/infra/generated/firecracker-hosts.yaml}"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "missing manifest: ${MANIFEST}" >&2
  echo "run terraform apply with generate_firecracker_hosts_gitops=true first" >&2
  exit 1
fi

kubectl apply -f "${MANIFEST}"
kubectl -n devin-firecracker get firecrackerhosts -o wide
