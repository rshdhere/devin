package hostpayload

import "fmt"

// SyncPlatformConfig invokes the installed binary, with a minimal secrets-only
// fallback for hosts that have not yet received the Go CLI.
func SyncPlatformConfig(region, prefix string) string {
	return fmt.Sprintf(`#!/bin/bash
set -euo pipefail
export AWS_REGION=%q DEVIN_SSM_PREFIX=%q SSM_PREFIX=%q
if [ -x /usr/local/bin/devin-infra ]; then
  exec /usr/local/bin/devin-infra sync-platform-config
fi
read_ssm() { aws ssm get-parameter --region "$AWS_REGION" --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null || true; }
mkdir -p /etc/devin /etc/systemd/system/devin-scheduler.service.d
umask 077
{
  echo "DEFAULT_AGENT=cursor"
  echo "SERVICE_MODE=worker"
  echo "CURSOR_API_KEY=$(read_ssm "$SSM_PREFIX/cursor_api_key")"
  echo "ANTHROPIC_API_KEY=$(read_ssm "$SSM_PREFIX/anthropic_api_key")"
  echo "OPENAI_API_KEY=$(read_ssm "$SSM_PREFIX/openai_api_key")"
  echo "GITHUB_BOT_TOKEN=$(read_ssm "$SSM_PREFIX/github_bot_token")"
  echo "GITHUB_BOT_NAME=baby-devin-bot"
  echo "GITHUB_BOT_EMAIL=baby-devin-bot@users.noreply.github.com"
  echo "AGENT_RUN_TIMEOUT_MIN=60"
  db="$(read_ssm "$SSM_PREFIX/database_url")"
  if [ -n "$db" ]; then echo "DATABASE_URL=$db"; fi
} >/etc/devin/scheduler-secrets.env
chmod 600 /etc/devin/scheduler-secrets.env
printf '[Service]\nEnvironmentFile=/etc/devin/scheduler-secrets.env\n' >/etc/systemd/system/devin-scheduler.service.d/secrets.conf
systemctl daemon-reload
systemctl restart devin-scheduler.service || true
`, region, prefix, prefix)
}
