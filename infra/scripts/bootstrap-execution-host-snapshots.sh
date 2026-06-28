#!/usr/bin/env bash
# Build Firecracker golden snapshots on an execution host (Path B).
# Intended for SSM Run Command or SSH as root on the EC2 host.
#
# Usage (on host):
#   sudo DEVIN_REPO_URL=https://github.com/rshdhere/devin.git ./bootstrap-execution-host-snapshots.sh
#
# Usage (from workstation via SSM):
#   ./run-ssm-bootstrap-snapshots.sh <instance-id> [aws-region]

set -euo pipefail

REPO_URL="${DEVIN_REPO_URL:-https://github.com/rshdhere/devin.git}"
REPO_REF="${DEVIN_REPO_REF:-main}"
BUILD_DIR="${DEVIN_BUILD_DIR:-/opt/devin-build}"
RUNTIMES="${DEVIN_RUNTIMES:-nextjs}"
CONTAINER_REGISTRY="${DEVIN_CONTAINER_REGISTRY:-docker.io/rshdhere}"
CONTAINER_IMAGE_TAG="${DEVIN_CONTAINER_IMAGE_TAG:-latest}"
FIRECRACKER_VERSION="${FIRECRACKER_VERSION:-1.8.0}"
MARKER="/var/lib/devin/.snapshots-bootstrapped"

log() {
  echo "[devin-bootstrap] $*"
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "run as root (sudo)" >&2
    exit 1
  fi
}

require_kvm() {
  if [[ -d /dev/kvm && ! -c /dev/kvm ]]; then
    log "repairing /dev/kvm (docker created a directory bind mount)"
    systemctl stop devin-firecracker-host.service 2>/dev/null || true
    docker stop firecracker-host 2>/dev/null || true
    rm -rf /dev/kvm
  fi
  modprobe kvm 2>/dev/null || true
  modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
  if [[ ! -c /dev/kvm ]]; then
    echo "ERROR: /dev/kvm not available on this instance." >&2
    echo "Enable nested virtualization on C7i (see infra/README.md) and re-run enable-nested-virtualization.sh" >&2
    exit 1
  fi
  log "KVM available: $(ls -l /dev/kvm)"
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates git golang-go e2fsprogs build-essential
}

install_firecracker() {
  if command -v firecracker >/dev/null; then
    return
  fi
  log "installing firecracker ${FIRECRACKER_VERSION}"
  tmpdir="$(mktemp -d)"
  curl -fsSL \
    "https://github.com/firecracker-microvm/firecracker/releases/download/v${FIRECRACKER_VERSION}/firecracker-v${FIRECRACKER_VERSION}-x86_64.tgz" \
    | tar -xzf - -C "${tmpdir}"
  install -m 755 \
    "${tmpdir}/release-v${FIRECRACKER_VERSION}-x86_64/firecracker-v${FIRECRACKER_VERSION}-x86_64" \
    /usr/local/bin/firecracker
  rm -rf "${tmpdir}"
}

install_cni() {
  mkdir -p /etc/cni/conf.d /opt/cni/bin

  if [[ ! -f /etc/cni/conf.d/fcnet.conflist ]]; then
    log "installing fcnet CNI config"
    local raw_base="${DEVIN_RAW_BASE:-https://raw.githubusercontent.com/rshdhere/devin/${REPO_REF}}"
    curl -fsSL \
      "${raw_base}/apps/firecracker-host/config/cni/fcnet.conflist" \
      -o /etc/cni/conf.d/fcnet.conflist
  fi

  if [[ ! -f /opt/cni/bin/tc-redirect-tap ]]; then
    log "extracting CNI plugins from devin-firecracker-host image"
    docker create --name devin-cni-extract "${CONTAINER_REGISTRY:-docker.io/rshdhere}/devin-firecracker-host:${CONTAINER_IMAGE_TAG:-latest}" >/dev/null
    docker cp devin-cni-extract:/opt/cni/bin/. /opt/cni/bin/
    docker rm devin-cni-extract >/dev/null
    chmod 755 /opt/cni/bin/*
  fi
}

install_kernel() {
  mkdir -p /var/lib/devin/linux
  if [[ ! -f /var/lib/devin/linux/vmlinux ]]; then
    log "downloading Firecracker kernel"
    curl -fsSL \
      -o /var/lib/devin/linux/vmlinux \
      https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin
  fi
}

clone_repo() {
  if [[ -d "${BUILD_DIR}/.git" ]]; then
    log "updating repo at ${BUILD_DIR}"
    git -C "${BUILD_DIR}" fetch --depth 1 origin "${REPO_REF}"
    git -C "${BUILD_DIR}" checkout "${REPO_REF}"
    git -C "${BUILD_DIR}" pull --ff-only origin "${REPO_REF}" 2>/dev/null || true
    return
  fi
  log "cloning ${REPO_URL} (${REPO_REF})"
  rm -rf "${BUILD_DIR}"
  git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" "${BUILD_DIR}"
}

build_runtime() {
  local runtime="$1"
  local snap_meta="/var/lib/devin/snapshots/${runtime}/meta.json"
  if [[ -f "${snap_meta}" ]]; then
    log "snapshot already exists for ${runtime}"
    return
  fi

  log "building rootfs + snapshot for ${runtime}"
  # Patch runtime Dockerfiles until main includes unzip for bun install.
  for df in "${BUILD_DIR}"/runtime/*/Dockerfile; do
    [[ -f "${df}" ]] || continue
    grep -q ' unzip ' "${df}" || sed -i 's/openssh-client \\$/openssh-client unzip \\/' "${df}"
  done
  (
    cd "${BUILD_DIR}"
    export HOME=/root
    export GOCACHE=/root/.cache/go-build
    export GOPATH=/root/go
    export PATH="/usr/local/bin:${PATH}"
    export FIRECRACKER_BIN=/usr/local/bin/firecracker
    mkdir -p "${GOCACHE}" "${GOPATH}"
    ./scripts/build-firecracker-rootfs.sh "${runtime}"
    ./scripts/build-firecracker-snapshot.sh "${runtime}"
  )
}

start_services() {
  if [[ -x /usr/local/bin/devin-sync-platform-config.sh ]]; then
    /usr/local/bin/devin-sync-platform-config.sh || true
  fi
  systemctl daemon-reload
  systemctl enable --now devin-firecracker-host.service
  systemctl enable --now devin-scheduler.service
  sleep 3
  curl -sf http://127.0.0.1:9092/health
  curl -sf http://127.0.0.1:9092/v1/status
  curl -sf http://127.0.0.1:9091/health
}

main() {
  require_root
  require_kvm

  if [[ -f "${MARKER}" ]]; then
    log "snapshots already bootstrapped (${MARKER})"
    start_services
    exit 0
  fi

  install_packages
  install_firecracker
  install_cni
  install_kernel
  mkdir -p /var/lib/devin/snapshots /var/lib/devin/vms
  clone_repo

  for runtime in ${RUNTIMES}; do
    build_runtime "${runtime}"
  done

  date -u +%Y-%m-%dT%H:%M:%SZ >"${MARKER}"
  start_services
  log "done"
}

main "$@"
