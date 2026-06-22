#!/usr/bin/env bash
set -euo pipefail

# Build a Firecracker rootfs ext4 image from a runtime Docker image.
#
# Usage:
#   ./scripts/build-firecracker-rootfs.sh nextjs devin-runtime-nextjs:latest
#
# Output:
#   /var/lib/devin/snapshots/<runtime>/rootfs.ext4

RUNTIME="${1:-nextjs}"
IMAGE="${2:-devin-runtime-${RUNTIME}:latest}"
OUT_DIR="${FIRECRACKER_SNAPSHOT_DIR:-/var/lib/devin/snapshots}/${RUNTIME}"
ROOTFS="${OUT_DIR}/rootfs.ext4"
SIZE_MB="${ROOTFS_SIZE_MB:-4096}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null; then
  echo "docker is required" >&2
  exit 1
fi

if [[ ! -f "${ROOT}/apps/runtime/bin/runtime" ]]; then
  echo "building runtime supervisor binary..."
  (cd "${ROOT}/apps/runtime" && go build -o bin/runtime ./cmd/runtime)
fi

echo "building docker image ${IMAGE}..."
docker build -f "${ROOT}/runtime/${RUNTIME}/Dockerfile" -t "${IMAGE}" "${ROOT}"

mkdir -p "${OUT_DIR}"
rm -f "${ROOTFS}"

echo "creating ${SIZE_MB}MB ext4 rootfs at ${ROOTFS}..."
truncate -s "${SIZE_MB}M" "${ROOTFS}"
mkfs.ext4 -F "${ROOTFS}" >/dev/null

MOUNT_DIR="$(mktemp -d)"
cleanup() {
  if mountpoint -q "${MOUNT_DIR}"; then
    umount "${MOUNT_DIR}" || true
  fi
  rmdir "${MOUNT_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

mount "${ROOTFS}" "${MOUNT_DIR}"

CID="$(docker create "${IMAGE}")"
docker export "${CID}" | tar -x -C "${MOUNT_DIR}"
docker rm "${CID}" >/dev/null

cat >"${OUT_DIR}/meta.partial.json" <<EOF
{
  "runtime": "${RUNTIME}",
  "version": "v1",
  "runtimePort": 8080,
  "rootfsPath": "${ROOTFS}"
}
EOF

echo "rootfs ready: ${ROOTFS}"
echo "next: ./scripts/build-firecracker-snapshot.sh ${RUNTIME}"
