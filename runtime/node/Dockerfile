FROM node:22-bookworm-slim

COPY runtime/scripts/install-build-toolchain.sh /tmp/install-build-toolchain.sh
RUN chmod +x /tmp/install-build-toolchain.sh \
    && /tmp/install-build-toolchain.sh \
    && rm -f /tmp/install-build-toolchain.sh \
    && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git chromium unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bunx

RUN npm install -g playwright-core@1.60.0 || true

COPY runtime/scripts/install-agent-tools.sh /tmp/install-agent-tools.sh
RUN chmod +x /tmp/install-agent-tools.sh \
    && /tmp/install-agent-tools.sh \
    && rm -f /tmp/install-agent-tools.sh

COPY runtime/scripts/install-desktop-stack.sh /tmp/install-desktop-stack.sh
RUN chmod +x /tmp/install-desktop-stack.sh \
    && /tmp/install-desktop-stack.sh \
    && rm -f /tmp/install-desktop-stack.sh

ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="/usr/local/cargo/bin:/root/.bun/bin:${PATH}"
ENV RUNTIME_PORT=8081
ENV RUNTIME_WORKSPACE=/workspace
ENV WORKSPACE_TMPFS_SIZE=12G
ENV HOME=/workspace/.home

WORKDIR /workspace
COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
