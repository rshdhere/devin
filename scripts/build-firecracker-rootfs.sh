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
# Rust + build-essential need more than the old 4Gi rootfs.
SIZE_MB="${ROOTFS_SIZE_MB:-8192}"

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
chattr -i "${ROOTFS}" 2>/dev/null || true
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

  # Resolve the real bash binary inside the rootfs and publish it on the legacy
  # guest PATH (/usr/local/bin first). Never point /usr/local/bin/bash at itself.
  BASH_CANDIDATE=""
  for candidate in "${MOUNT_DIR}/bin/bash" "${MOUNT_DIR}/usr/bin/bash"; do
    if [[ -e "${candidate}" ]]; then
      BASH_CANDIDATE="${candidate}"
      break
    fi
  done
  if [[ -z "${BASH_CANDIDATE}" ]]; then
    echo "ERROR: bash missing from ${IMAGE}." >&2
    exit 1
  fi
  BASH_REAL="$(readlink -f "${BASH_CANDIDATE}")"
  if [[ -z "${BASH_REAL}" || ! -e "${BASH_REAL}" ]]; then
    echo "ERROR: could not resolve bash binary in rootfs (${BASH_CANDIDATE})." >&2
    exit 1
  fi
  BASH_GUEST="${BASH_REAL#${MOUNT_DIR}}"
  if [[ "${BASH_GUEST}" == "${BASH_REAL}" || -z "${BASH_GUEST}" ]]; then
    echo "ERROR: resolved bash path is outside rootfs: ${BASH_REAL}" >&2
    exit 1
  fi
  if [[ "${BASH_GUEST}" == "/usr/local/bin/bash" ]]; then
    echo "ERROR: bash resolved to /usr/local/bin/bash (would create a symlink loop)." >&2
    exit 1
  fi
  ln -sfn "${BASH_GUEST}" "${MOUNT_DIR}/usr/local/bin/bash"
  if [[ -L "${MOUNT_DIR}/usr/local/bin/bash" ]]; then
    LINK_TARGET="$(readlink -f "${MOUNT_DIR}/usr/local/bin/bash" 2>/dev/null || true)"
    if [[ -z "${LINK_TARGET}" || "${LINK_TARGET}" == "${MOUNT_DIR}/usr/local/bin/bash" ]]; then
      echo "ERROR: /usr/local/bin/bash symlink loop in rootfs." >&2
      exit 1
    fi
  fi
  # Verify #!/usr/bin/env bash works with the stripped guest PATH.
  if ! docker run --rm --entrypoint /usr/bin/env "${IMAGE}" \
      PATH="/usr/local/bin:/root/.local/bin" bash -c 'echo ok' >/dev/null; then
    echo "ERROR: PATH=/usr/local/bin:/root/.local/bin cannot resolve bash in ${IMAGE}." >&2
    echo "Fix runtime/agent/Dockerfile (link real bash into /usr/local/bin/bash)." >&2
    exit 1
  fi
  echo "bash ready for env shebang: /usr/local/bin/bash -> ${BASH_GUEST}"
fi

echo "verifying Rust/GCC toolchain is present in rootfs..."
for tool in cargo rustc gcc; do
  FOUND=""
  for candidate in \
    "${MOUNT_DIR}/usr/local/bin/${tool}" \
    "${MOUNT_DIR}/usr/local/cargo/bin/${tool}" \
    "${MOUNT_DIR}/usr/bin/${tool}"
  do
    if [[ -e "${candidate}" ]]; then
      FOUND="${candidate}"
      break
    fi
  done
  if [[ -z "${FOUND}" ]]; then
    echo "ERROR: ${tool} missing from ${IMAGE}." >&2
    echo "Every sandbox image must ship Rust/Cargo and GCC via runtime/scripts/install-build-toolchain.sh." >&2
    exit 1
  fi
  echo "${tool} present: ${FOUND#${MOUNT_DIR}}"
done

if [[ "${RUNTIME}" != "agent" ]]; then
  echo "verifying agent CLIs are present in stack rootfs..."
  for tool in agent claude; do
    if [[ ! -e "${MOUNT_DIR}/usr/local/bin/${tool}" ]]; then
      echo "ERROR: ${tool} missing from ${IMAGE}." >&2
      echo "Stack-specific snapshots must include runtime/scripts/install-agent-tools.sh." >&2
      exit 1
    fi
  done
fi

if mountpoint -q "${MOUNT_DIR}"; then
  sync
  umount "${MOUNT_DIR}"
fi
echo "checking rootfs filesystem..."
set +e
e2fsck -f -y "${ROOTFS}" >/tmp/devin-rootfs-e2fsck.${RUNTIME}.log 2>&1
fsck_status=$?
set -e
if [[ "${fsck_status}" -ge 4 ]]; then
  echo "e2fsck failed for ${ROOTFS} (exit ${fsck_status})" >&2
  tail -50 "/tmp/devin-rootfs-e2fsck.${RUNTIME}.log" >&2 || true
  exit 1
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
