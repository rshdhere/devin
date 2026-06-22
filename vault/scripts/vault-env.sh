#!/usr/bin/env bash
# Export Vault KV secrets as shell environment variables for local development.
#
# Usage:
#   source vault/scripts/vault-env.sh server
#   source vault/scripts/vault-env.sh scheduler
set -euo pipefail

SERVICE="${1:-server}"
ENV_NAME="${VAULT_ENV:-dev}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"

if [[ -f "${ROOT}/.local/tokens.env" ]]; then
  # shellcheck disable=SC1091
  source "${ROOT}/.local/tokens.env"
fi

case "${SERVICE}" in
  server)   export VAULT_TOKEN="${VAULT_TOKEN_SERVER:-${VAULT_TOKEN:-dev-root-token}}" ;;
  scheduler) export VAULT_TOKEN="${VAULT_TOKEN_SCHEDULER:-${VAULT_TOKEN:-dev-root-token}}" ;;
  ci)       export VAULT_TOKEN="${VAULT_TOKEN_CI:-${VAULT_TOKEN:-dev-root-token}}" ;;
  *) echo "Unknown service: ${SERVICE} (use server|scheduler|ci)" >&2; return 1 2>/dev/null || exit 1 ;;
esac

if ! command -v vault >/dev/null 2>&1; then
  echo "vault CLI not found — install https://developer.hashicorp.com/vault/downloads" >&2
  return 1 2>/dev/null || exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found — required to parse Vault JSON output" >&2
  return 1 2>/dev/null || exit 1
fi

PATH_KV="secret/${ENV_NAME}/${SERVICE}"
JSON="$(vault kv get -format=json "${PATH_KV}" 2>/dev/null)" || {
  echo "No secrets at ${PATH_KV}. Run: ./vault/bootstrap/local.sh" >&2
  return 1 2>/dev/null || exit 1
}

while IFS= read -r line; do
  export "${line?}"
done < <(echo "${JSON}" | jq -r '.data.data | to_entries[] | "\(.key)=\(.value|@sh)"' | sed "s/^'//;s/'$//")

echo "Loaded ${PATH_KV} into environment (${SERVICE})"
