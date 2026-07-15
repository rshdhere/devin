#!/usr/bin/env bash
# Install Caddy on an execution host for Lovable-style subdomain previews.
#
# Usage (on the host, or via SSM):
#   ./install-preview-caddy.sh
#
# Expects repo Caddyfile at infra/caddy/Caddyfile relative to this script,
# or pass an absolute path as $1.
set -euo pipefail

CADDYFILE_SRC="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$CADDYFILE_SRC" ]]; then
  CADDYFILE_SRC="${SCRIPT_DIR}/../caddy/Caddyfile"
fi
if [[ ! -f "$CADDYFILE_SRC" ]]; then
  echo "Caddyfile not found at $CADDYFILE_SRC" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

if ! command -v caddy >/dev/null 2>&1; then
  echo "Installing Caddy…"
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

mkdir -p /etc/caddy
cp "$CADDYFILE_SRC" /etc/caddy/Caddyfile
chmod 644 /etc/caddy/Caddyfile

# Official package ships caddy.service; ensure it is enabled and reloaded.
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy
systemctl --no-pager --full status caddy | head -40

echo "Caddy preview edge installed."
echo "Caddyfile: /etc/caddy/Caddyfile"
echo "Upstream: 127.0.0.1:9091 (scheduler Host-based preview proxy)"
