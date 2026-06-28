# Agent runtime — Cursor CLI + Claude Code in Firecracker microVMs
#
# Build from repo root:
#   go build -o apps/runtime/bin/runtime ./apps/runtime/cmd/runtime
#   docker build -f runtime/agent/Dockerfile -t devin-runtime-agent:latest .

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client unzip \
    && rm -rf /var/lib/apt/lists/*

# Cursor Agent CLI
RUN curl -fsSL https://cursor.com/install | bash \
    && ln -sf /root/.local/bin/agent /usr/local/bin/agent

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@latest \
    && ln -sf "$(npm root -g)/@anthropic-ai/claude-code/cli.js" /usr/local/bin/claude || true

ENV PATH="/root/.local/bin:/usr/local/bin:${PATH}"
ENV AGENT_PROVIDER=mock
ENV RUNTIME_PORT=8080

WORKDIR /workspace
COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
