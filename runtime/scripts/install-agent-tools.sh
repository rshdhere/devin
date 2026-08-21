#!/usr/bin/env bash
set -euo pipefail

# Stack-specific snapshots are also valid Cursor/Claude execution snapshots.
# Keep the agent CLIs in every image because runtime selection now follows
# the requested stack instead of forcing every runtime agent onto `agent`.
export DEBIAN_FRONTEND=noninteractive

packages=(bash ca-certificates curl)

apt-get update
apt-get install -y --no-install-recommends "${packages[@]}"
rm -rf /var/lib/apt/lists/*

# Claude Code now requires Node 22. Debian Bookworm's nodejs package is Node
# 18, so install the current Node 22 LTS when a stack image does not already
# provide a sufficiently new Node runtime (Python, Go, and Rust images).
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/' || true)"
fi
if ! [[ "${node_major}" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi

curl https://cursor.com/install -fsS | bash
test -x /root/.local/bin/agent
mkdir -p /usr/local/bin /root/.cursor
ln -sfn /root/.local/bin/agent /usr/local/bin/agent
printf '%s\n' '{"version":1,"attribution":{"attributeCommitsToAgent":false,"attributePRsToAgent":false}}' \
  > /root/.cursor/cli-config.json

npm install -g @anthropic-ai/claude-code@latest
claude_bin="$(npm prefix -g)/bin/claude"
test -x "${claude_bin}"
ln -sf "${claude_bin}" /usr/local/bin/claude

/usr/local/bin/agent --version
/usr/local/bin/claude --version
