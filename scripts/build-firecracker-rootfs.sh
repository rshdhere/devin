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

echo "building runtime supervisor binary..."
(cd "${ROOT}/apps/runtime" && go build -o bin/runtime ./cmd/runtime)

echo "building docker image ${IMAGE}..."
BUILD_FLAGS=()
if [[ "${DEVIN_FORCE_SNAPSHOT_REBUILD:-false}" == "true" ]]; then
  BUILD_FLAGS+=(--no-cache)
fi
docker build "${BUILD_FLAGS[@]}" -f "${ROOT}/runtime/${RUNTIME}/Dockerfile" -t "${IMAGE}" "${ROOT}"

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

if [[ "${RUNTIME}" == "agent" ]]; then
  echo "verifying cursor agent CLI is present in rootfs..."
  AGENT_BIN=""
  for candidate in \
    "${MOUNT_DIR}/usr/local/bin/agent" \
    "${MOUNT_DIR}/root/.local/bin/agent"
  do
    if [[ -e "${candidate}" ]]; then
      AGENT_BIN="${candidate}"
      break
    fi
  done
  if [[ -z "${AGENT_BIN}" ]]; then
    AGENT_BIN="$(find "${MOUNT_DIR}/root/.local/share/cursor-agent" -name cursor-agent -type f 2>/dev/null | sort | tail -1 || true)"
  fi
  if [[ -z "${AGENT_BIN}" || ! -e "${AGENT_BIN}" ]]; then
    echo "ERROR: cursor agent CLI missing from ${IMAGE}." >&2
    echo "The agent snapshot cannot rely on in-guest curl install (often SSL-timeouts)." >&2
    echo "Fix runtime/agent/Dockerfile install, rebuild with DEVIN_FORCE_SNAPSHOT_REBUILD=true." >&2
    exit 1
  fi
  echo "cursor agent present: ${AGENT_BIN#${MOUNT_DIR}}"
  if [[ ! -x "${MOUNT_DIR}/bin/bash" && ! -x "${MOUNT_DIR}/usr/bin/bash" ]]; then
    echo "ERROR: bash missing from ${IMAGE}." >&2
    echo "Cursor agent shebang is #!/usr/bin/env bash — install bash in runtime/agent/Dockerfile." >&2
    exit 1
  fi
  # Ensure a stable path for the runtime supervisor (absolute path inside guest).
  mkdir -p "${MOUNT_DIR}/usr/local/bin"
  if [[ ! -e "${MOUNT_DIR}/usr/local/bin/agent" ]]; then
    guest_path="${AGENT_BIN#${MOUNT_DIR}}"
    ln -sfn "${guest_path}" "${MOUNT_DIR}/usr/local/bin/agent"
  fi
fi

cat >"${OUT_DIR}/meta.partial.json" <<EOF
{
  "runtime": "${RUNTIME}",
  "version": "v1",
  "runtimePort": 8081,
  "rootfsPath": "${ROOTFS}"
}
EOF

echo "rootfs ready: ${ROOTFS}"
echo "next: ./scripts/build-firecracker-snapshot.sh ${RUNTIME}"
