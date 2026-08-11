FROM rust:1.83-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git pkg-config libssl-dev chromium \
    && rm -rf /var/lib/apt/lists/*

ENV RUST_BACKTRACE=1

WORKDIR /workspace
COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
