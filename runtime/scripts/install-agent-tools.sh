#!/usr/bin/env bash
set -euo pipefail

# Stack-specific snapshots are also valid Cursor/Claude execution snapshots.
# Keep the agent CLIs in every image because runtime selection now follows
# the requested stack instead of forcing every runtime agent onto `agent`.
export DEBIAN_FRONTEND=noninteractive

packages=(bash ca-certificates curl)
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  packages+=(nodejs npm)
fi

apt-get update
apt-get install -y --no-install-recommends "${packages[@]}"
rm -rf /var/lib/apt/lists/*

curl https://cursor.com/install -fsS | bash
test -x /root/.local/bin/agent
mkdir -p /usr/local/bin /root/.cursor
ln -sfn /root/.local/bin/agent /usr/local/bin/agent
printf '%s\n' '{"version":1,"attribution":{"attributeCommitsToAgent":false,"attributePRsToAgent":false}}' \
  > /root/.cursor/cli-config.json

npm install -g @anthropic-ai/claude-code@latest
ln -sf "$(npm root -g)/@anthropic-ai/claude-code/cli.js" /usr/local/bin/claude

/usr/local/bin/agent --version
/usr/local/bin/claude --version
