#!/usr/bin/env bash
# Configure Vault after Helm install on EKS (run once per cluster).
# Requires: vault CLI, kubectl, VAULT_TOKEN (root or admin).
#
# Usage:
#   export VAULT_ADDR=https://vault.internal.example.com
#   export VAULT_TOKEN=<root-token>
#   ./vault/bootstrap/kubernetes.sh --env prod --cluster devin
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_NAME="dev"
CLUSTER_NAME="devin"
K8S_AUTH_PATH="kubernetes"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --env ENV           Environment path prefix (dev|staging|prod). Default: dev
  --cluster NAME      EKS cluster name for Kubernetes auth. Default: devin
  --auth-path PATH    Kubernetes auth mount path. Default: kubernetes
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --cluster) CLUSTER_NAME="$2"; shift 2 ;;
    --auth-path) K8S_AUTH_PATH="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

: "${VAULT_ADDR:?Set VAULT_ADDR to your Vault API URL}"
: "${VAULT_TOKEN:?Set VAULT_TOKEN to a root or admin token}"

echo "==> Vault status"
vault status

echo "==> Enabling KV v2 at secret/"
vault secrets enable -path=secret kv-v2 2>/dev/null || true

echo "==> Loading policies"
for policy in "${ROOT}/config/policies/"*.hcl; do
  name="$(basename "${policy}" .hcl)"
  vault policy write "${name}" "${policy}"
done

echo "==> Enabling Kubernetes auth at auth/${K8S_AUTH_PATH}"
vault auth enable -path="${K8S_AUTH_PATH}" kubernetes 2>/dev/null || true

K8S_HOST="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
CA_CERT="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d)"
SA_JWT="$(kubectl create token vault-auth -n vault --duration=10m 2>/dev/null || kubectl get secret -n vault -o jsonpath='{.items[?(@.type=="kubernetes.io/service-account-token")].data.token}' | head -1 | base64 -d)"

vault write "auth/${K8S_AUTH_PATH}/config" \
  kubernetes_host="${K8S_HOST}" \
  kubernetes_ca_cert="${CA_CERT}" \
  token_reviewer_jwt="${SA_JWT}"

echo "==> Creating Kubernetes auth roles"

# devin-server in devin-app namespace
vault write "auth/${K8S_AUTH_PATH}/role/devin-server" \
  bound_service_account_names=devin-server \
  bound_service_account_namespaces=devin-app \
  policies=server \
  ttl=1h

# External Secrets Operator (optional — syncs Vault → K8s Secret)
vault write "auth/${K8S_AUTH_PATH}/role/external-secrets" \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=server \
  ttl=1h

echo "==> Enabling AppRole auth for EC2 execution hosts (scheduler)"
vault auth enable approle 2>/dev/null || true

vault write "auth/approle/role/scheduler" \
  token_policies=scheduler \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=0

ROLE_ID="$(vault read -field=role_id auth/approle/role/scheduler/role-id)"
SECRET_ID="$(vault write -f -field=secret_id auth/approle/role/scheduler/secret-id)"

echo ""
echo "Kubernetes auth configured for cluster: ${CLUSTER_NAME}"
echo "Environment prefix: secret/${ENV_NAME}/*"
echo ""
echo "Next steps:"
echo "  1. Store secrets:  vault kv put secret/${ENV_NAME}/server DATABASE_URL=..."
echo "  2. GitOps: apply vault/examples/external-secrets.yaml"
echo "  3. EC2 scheduler AppRole (store on execution host, not in git):"
echo "       VAULT_ROLE_ID=${ROLE_ID}"
echo "       VAULT_SECRET_ID=${SECRET_ID}"
