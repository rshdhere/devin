FROM rust:1.83-bookworm

COPY runtime/scripts/install-build-toolchain.sh /tmp/install-build-toolchain.sh
# Official rust image already ships cargo; still ensure build-essential + stable paths.
RUN chmod +x /tmp/install-build-toolchain.sh \
    && /tmp/install-build-toolchain.sh \
    && rm -f /tmp/install-build-toolchain.sh \
    && apt-get update && apt-get install -y --no-install-recommends \
      git chromium \
    && rm -rf /var/lib/apt/lists/*

COPY runtime/scripts/install-agent-tools.sh /tmp/install-agent-tools.sh
RUN chmod +x /tmp/install-agent-tools.sh \
    && /tmp/install-agent-tools.sh \
    && rm -f /tmp/install-agent-tools.sh

COPY runtime/scripts/install-desktop-stack.sh /tmp/install-desktop-stack.sh
RUN chmod +x /tmp/install-desktop-stack.sh \
    && /tmp/install-desktop-stack.sh \
    && rm -f /tmp/install-desktop-stack.sh

ENV RUST_BACKTRACE=1
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"
ENV RUNTIME_PORT=8081
ENV RUNTIME_WORKSPACE=/workspace
ENV WORKSPACE_TMPFS_SIZE=12G
ENV HOME=/workspace/.home

WORKDIR /workspace
COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
