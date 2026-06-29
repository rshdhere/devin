#!/usr/bin/env bash
# Store a platform secret in AWS SSM for execution host schedulers.
#
# Usage:
#   ./set-platform-secret.sh cursor_api_key
#   ./set-platform-secret.sh github_bot_token
#   CURSOR_API_KEY=sk-... ./set-platform-secret.sh cursor_api_key
#
# Prompts for the value when not passed via env (CURSOR_API_KEY, ANTHROPIC_API_KEY, GITHUB_BOT_TOKEN).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <cursor_api_key|anthropic_api_key|github_bot_token> [value]" >&2
  exit 1
fi

KEY_NAME="$1"
AWS_REGION="${AWS_REGION:-ap-south-1}"
SSM_PREFIX="${DEVIN_SSM_PREFIX:-/${DEVIN_NAME_PREFIX:-devin-production}/platform}"
PARAM_NAME="${SSM_PREFIX}/${KEY_NAME}"

case "$KEY_NAME" in
  cursor_api_key)
    VALUE="${2:-${CURSOR_API_KEY:-}}"
    ;;
  anthropic_api_key)
    VALUE="${2:-${ANTHROPIC_API_KEY:-}}"
    ;;
  github_bot_token)
    VALUE="${2:-${GITHUB_BOT_TOKEN:-}}"
    ;;
  *)
    echo "Unknown secret: $KEY_NAME" >&2
    exit 1
    ;;
esac

if [[ -z "$VALUE" ]]; then
  read -r -s -p "Enter value for ${PARAM_NAME}: " VALUE
  echo
fi

if [[ -z "$VALUE" ]]; then
  echo "Empty value — aborting" >&2
  exit 1
fi

aws ssm put-parameter \
  --region "$AWS_REGION" \
  --name "$PARAM_NAME" \
  --type SecureString \
  --value "$VALUE" \
  --overwrite

echo "Stored ${PARAM_NAME} (SecureString)"
echo "Sync execution hosts: ./infra/scripts/sync-execution-host-config.sh <instance-id>"
