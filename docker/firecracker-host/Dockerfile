FROM golang:1.23-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY apps/firecracker-host/go.mod apps/firecracker-host/go.sum ./
RUN go mod download
COPY apps/firecracker-host/ ./
RUN CGO_ENABLED=0 go build -o /out/firecracker-host ./cmd/host

ARG TC_REDIRECT_TAP_REF=34bf829e9a5c99df47318c7feeb637576df239fc
RUN git clone https://github.com/awslabs/tc-redirect-tap.git /tmp/tc-redirect-tap \
    && cd /tmp/tc-redirect-tap \
    && git checkout ${TC_REDIRECT_TAP_REF} \
    && CGO_ENABLED=0 go build -o /out/tc-redirect-tap ./cmd/tc-redirect-tap

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl iproute2 iptables \
    && rm -rf /var/lib/apt/lists/*

ARG FIRECRACKER_VERSION=1.8.0
RUN curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/v${FIRECRACKER_VERSION}/firecracker-v${FIRECRACKER_VERSION}-x86_64.tgz" \
    | tar -xzf - -C /tmp \
    && mv /tmp/release-v${FIRECRACKER_VERSION}-x86_64/firecracker-v${FIRECRACKER_VERSION}-x86_64 /usr/bin/firecracker \
    && mv /tmp/release-v${FIRECRACKER_VERSION}-x86_64/jailer-v${FIRECRACKER_VERSION}-x86_64 /usr/bin/jailer \
    && rm -rf /tmp/release-v${FIRECRACKER_VERSION}-x86_64

ARG CNI_PLUGINS_VERSION=1.4.1
RUN mkdir -p /opt/cni/bin \
    && curl -fsSL "https://github.com/containernetworking/plugins/releases/download/v${CNI_PLUGINS_VERSION}/cni-plugins-linux-amd64-v${CNI_PLUGINS_VERSION}.tgz" \
    | tar -xzf - -C /opt/cni/bin

COPY --from=build /out/tc-redirect-tap /opt/cni/bin/tc-redirect-tap
RUN chmod 755 /opt/cni/bin/tc-redirect-tap

RUN mkdir -p /etc/cni/conf.d

COPY apps/firecracker-host/config/cni/fcnet.conflist /etc/cni/conf.d/
COPY apps/firecracker-host/config/cni/resolv.conf /etc/cni/resolv.conf
COPY --from=build /out/firecracker-host /usr/bin/firecracker-host

ENV FIRECRACKER_BIN=/usr/bin/firecracker \
    FIRECRACKER_CNI_CONF_DIR=/etc/cni/conf.d \
    FIRECRACKER_CNI_BIN_PATH=/opt/cni/bin \
    FIRECRACKER_CNI_NETWORK=fcnet \
    FIRECRACKER_SNAPSHOT_DIR=/var/lib/devin/snapshots \
    FIRECRACKER_KERNEL_PATH=/var/lib/devin/linux/vmlinux \
    FIRECRACKER_VMM_DIR=/var/lib/devin/vms \
    FIRECRACKER_DRY_RUN=false \
    FIRECRACKER_HOST_PORT=9092

EXPOSE 9092
ENTRYPOINT ["/usr/bin/firecracker-host"]
