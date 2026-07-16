# Agent runtime — Cursor CLI + Claude Code in Firecracker microVMs
#
# Build from repo root:
#   go build -o apps/runtime/bin/runtime ./apps/runtime/cmd/runtime
#   docker build -f runtime/agent/Dockerfile -t devin-runtime-agent:latest .

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client unzip \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI for repo, issue, and PR automation inside sandboxes
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Cursor Agent CLI — must be baked into the snapshot; in-guest install is unreliable.
RUN curl https://cursor.com/install -fsS | bash \
    && test -x /root/.local/bin/agent \
    && ln -sfn /root/.local/bin/agent /usr/local/bin/agent \
    && /usr/local/bin/agent --version

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@latest \
    && ln -sf "$(npm root -g)/@anthropic-ai/claude-code/cli.js" /usr/local/bin/claude || true

ENV PATH="/root/.local/bin:/usr/local/bin:${PATH}"
ENV AGENT_PROVIDER=mock
ENV AGENT_RUN_TIMEOUT_MIN=120
ENV RUNTIME_PORT=8081
ENV RUNTIME_WORKSPACE=/workspace

WORKDIR /workspace

COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
