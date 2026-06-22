# Go runtime — toolchain for services, CLIs, and backend work.
#
# Build from repo root:
#   go build -o apps/runtime/bin/runtime ./apps/runtime/cmd/runtime
#   docker build -f runtime/go/Dockerfile -t devin-runtime-go:latest .

FROM golang:1.23-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

ENV CGO_ENABLED=0
ENV GOPATH=/go
ENV PATH="${GOPATH}/bin:${PATH}"

WORKDIR /workspace
COPY apps/runtime/bin/runtime /usr/local/bin/devin-runtime-supervisor

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/devin-runtime-supervisor"]
