#!/usr/bin/env bash
# Install / refresh Caddy preview edge on an execution host via SSM.
#
# Usage:
#   AWS_REGION=ap-south-1 ./install-preview-caddy-ssm.sh [instance-id]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_REGION="${AWS_REGION:-ap-south-1}"
INSTANCE_ID="${1:-i-07232620d98d8c7fd}"
CADDYFILE_SRC="${SCRIPT_DIR}/../caddy/Caddyfile"

if [[ ! -f "$CADDYFILE_SRC" ]]; then
  echo "Missing $CADDYFILE_SRC" >&2
  exit 1
fi

# Embed Caddyfile + installer into a single remote shell script.
CADDYFILE_B64="$(base64 -w0 <"$CADDYFILE_SRC")"

REMOTE=$(cat <<EOF
bash -seu <<'REMOTE_SCRIPT'
export DEBIAN_FRONTEND=noninteractive
mkdir -p /tmp/devin-preview-caddy /etc/caddy /usr/local/bin
echo '${CADDYFILE_B64}' | base64 -d >/tmp/devin-preview-caddy/Caddyfile

if ! command -v caddy >/dev/null 2>&1; then
  echo "Installing Caddy…"
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

cp /tmp/devin-preview-caddy/Caddyfile /etc/caddy/Caddyfile
chmod 644 /etc/caddy/Caddyfile

# Persist installer for deploy-execution-host-images.sh refresh hook.
cat >/usr/local/bin/install-preview-caddy.sh <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
SRC="\${1:-/etc/caddy/Caddyfile}"
if [[ ! -f "\$SRC" ]]; then
  echo "Caddyfile not found: \$SRC" >&2
  exit 1
fi
cp "\$SRC" /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy
INSTALL
chmod +x /usr/local/bin/install-preview-caddy.sh

systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy
sleep 2
systemctl --no-pager --full status caddy | head -40
ss -lntp | grep -E ':(80|443)\\b' || true
curl -sS -o /dev/null -w 'scheduler_health=%{http_code}\\n' http://127.0.0.1:9091/health || true
curl -sS -o /dev/null -w 'tls_ask=%{http_code}\\n' \
  'http://127.0.0.1:9091/internal/v1/preview/tls-allowed?domain=abc123xyz.3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby' || true
echo "Caddy preview edge ready"
REMOTE_SCRIPT
EOF
)

PARAMS=$(jq -n --arg cmd "$REMOTE" '{commands: [$cmd]}')

echo "Installing Caddy on ${INSTANCE_ID}…"
COMMAND_ID=$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --comment "Install preview Caddy edge" \
  --timeout-seconds 600 \
  --parameters "${PARAMS}" \
  --query "Command.CommandId" \
  --output text)

echo "CommandId: ${COMMAND_ID}"

for _ in $(seq 1 90); do
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
      exit 0
      ;;
    Failed|Cancelled|TimedOut)
      aws ssm get-command-invocation \
        --region "${AWS_REGION}" \
        --command-id "${COMMAND_ID}" \
        --instance-id "${INSTANCE_ID}" \
        --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      exit 1
      ;;
    *)
      sleep 5
      ;;
  esac
done

echo "Timed out waiting for SSM command" >&2
exit 1
