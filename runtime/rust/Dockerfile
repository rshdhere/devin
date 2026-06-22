# Rust runtime — toolchain for systems work and native tooling.
#
# Build from repo root:
#   go build -o apps/runtime/bin/runtime ./apps/runtime/cmd/runtime
#   docker build -f runtime/rust/Dockerfile -t devin-runtime-rust:latest .

FROM rust:1.83-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

ENV RUST_BACKTRACE=1

WORKDIR /workspace
COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
