package hostpayload

import "fmt"

// SyncPlatformConfig invokes the installed binary, with a minimal secrets-only
// fallback for hosts that have not yet received the Go CLI. The fallback stays
// inline (no docker/git needed) so config sync works on a degraded host.
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
  echo "DEFAULT_AGENT=brain"
  echo "SERVICE_MODE=worker"
  tg="$(read_ssm "$SSM_PREFIX/tool_gateway_grpc_url")"
  if [ -z "$tg" ]; then tg="127.0.0.1:9095"; fi
  echo "TOOL_GATEWAY_GRPC_URL=$tg"
  echo "GITHUB_BOT_TOKEN=$(read_ssm "$SSM_PREFIX/github_bot_token")"
  echo "GITHUB_BOT_NAME=baby-devin-bot"
  echo "GITHUB_BOT_EMAIL=baby-devin-bot@users.noreply.github.com"
  echo "AGENT_RUN_TIMEOUT_MIN=60"
  model="$(read_ssm "$SSM_PREFIX/agent_model")"
  if [ -z "$model" ]; then model="gpt-4o-mini"; fi
  echo "AGENT_MODEL=$model"
  echo "OPENAI_MODEL=$model"
  echo "DEVIN_SNAPSHOT_DIR=/var/lib/devin/task-snapshots"
  brain="$(read_ssm "$SSM_PREFIX/brain_internal_url")"
  if [ -n "$brain" ]; then echo "BRAIN_INTERNAL_URL=$brain"; fi
  db="$(read_ssm "$SSM_PREFIX/database_url")"
  if [ -n "$db" ]; then echo "DATABASE_URL=$db"; fi
} >/etc/devin/scheduler-secrets.env
chmod 600 /etc/devin/scheduler-secrets.env
mkdir -p /var/lib/devin/task-snapshots
chown 1001:1001 /var/lib/devin/task-snapshots
printf '[Service]\nEnvironmentFile=/etc/devin/scheduler-secrets.env\n' >/etc/systemd/system/devin-scheduler.service.d/secrets.conf
systemctl daemon-reload
systemctl enable --now devin-tool-gateway.service || true
systemctl restart devin-tool-gateway.service || true
systemctl restart devin-scheduler.service || true
`, region, prefix, prefix)
}
