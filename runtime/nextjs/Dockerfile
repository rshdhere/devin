# Next.js runtime — Node 22 + Bun for app scaffolding, dev server, and builds.
#
# Build from repo root:
#   go build -o apps/runtime/bin/runtime ./apps/runtime/cmd/runtime
#   docker build -f runtime/nextjs/Dockerfile -t devin-runtime-nextjs:latest .

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

ENV PATH="/root/.bun/bin:${PATH}"
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /workspace
COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
