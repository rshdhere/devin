FROM node:22-bookworm-slim

# Cursor agent shebang is #!/usr/bin/env bash. Guests may boot with PATH limited
# to /usr/local/bin:/root/.local/bin — expose a real bash there. Always link the
# canonical binary (never /usr/local/bin/bash → itself).
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git openssh-client unzip chromium \
    && rm -rf /var/lib/apt/lists/* \
    && BASH_REAL="$(readlink -f /bin/bash 2>/dev/null || readlink -f /usr/bin/bash)" \
    && test -x "$BASH_REAL" \
    && ln -sfn "$BASH_REAL" /usr/local/bin/bash \
    && test -x /usr/local/bin/bash \
    && PATH="/usr/local/bin:/root/.local/bin" /usr/bin/env bash -c 'echo ok'

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN curl https://cursor.com/install -fsS | bash \
    && test -x /root/.local/bin/agent \
    && ln -sfn /root/.local/bin/agent /usr/local/bin/agent \
    && /usr/local/bin/agent --version

# The CLI credits itself as a commit co-author by default, which would list
# cursoragent as a contributor on every repository this product ships. No auth
# state exists at build time, so a plain write is safe here.
RUN mkdir -p /root/.cursor \
    && printf '%s\n' '{"version":1,"attribution":{"attributeCommitsToAgent":false,"attributePRsToAgent":false}}' \
      > /root/.cursor/cli-config.json

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
