#!/usr/bin/env bash
set -euo pipefail

# Create a golden Firecracker snapshot for a runtime.
#
# Prerequisites:
#   - firecracker binary on PATH or FIRECRACKER_BIN
#   - vmlinux at FIRECRACKER_KERNEL_PATH (default /var/lib/devin/linux/vmlinux)
#   - rootfs.ext4 from build-firecracker-rootfs.sh
#   - CNI plugins installed under /opt/cni/bin with fcnet.conflist in /etc/cni/conf.d
#   - CAP_SYS_ADMIN + CAP_NET_ADMIN (run as root on a Linux host)
#
# Usage:
#   sudo ./scripts/build-firecracker-snapshot.sh nextjs

RUNTIME="${1:-nextjs}"
SNAP_DIR="${FIRECRACKER_SNAPSHOT_DIR:-/var/lib/devin/snapshots}/${RUNTIME}"
KERNEL="${FIRECRACKER_KERNEL_PATH:-/var/lib/devin/linux/vmlinux}"
FC_BIN="${FIRECRACKER_BIN:-firecracker}"
ROOTFS="${SNAP_DIR}/rootfs.ext4"
MEM="${SNAP_DIR}/mem.snap"
VM="${SNAP_DIR}/vm.snap"
META="${SNAP_DIR}/meta.json"
WORK="${SNAP_DIR}/.build"
VCPU_COUNT="${FIRECRACKER_SNAPSHOT_VCPU:-2}"
MEM_SIZE_MIB="${FIRECRACKER_SNAPSHOT_MEM_MIB:-8192}"
RUNTIME_PORT="${FIRECRACKER_RUNTIME_PORT:-8081}"
CNI_NETWORK="${FIRECRACKER_CNI_NETWORK:-fcnet}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_CNI_BIN="${SNAPSHOT_CNI_BIN:-${ROOT}/apps/firecracker/bin/snapshot-cni}"
CONTAINER_ID="snapshot-build-${RUNTIME}-$$"

if [[ ! -f "${ROOTFS}" ]]; then
  echo "missing rootfs: ${ROOTFS}" >&2
  echo "run: ./scripts/build-firecracker-rootfs.sh ${RUNTIME}" >&2
  exit 1
fi

if [[ ! -f "${KERNEL}" ]]; then
  echo "missing kernel: ${KERNEL}" >&2
  echo "download a Firecracker-compatible vmlinux and place it at FIRECRACKER_KERNEL_PATH" >&2
  exit 1
fi

if ! command -v "${FC_BIN}" >/dev/null; then
  echo "firecracker binary not found: ${FC_BIN}" >&2
  exit 1
fi

if [[ ! -x "${SNAPSHOT_CNI_BIN}" ]]; then
  echo "building snapshot-cni helper..."
  (cd "${ROOT}/apps/firecracker" && go build -o "${SNAPSHOT_CNI_BIN}" ./cmd/snapshot-cni)
fi

mkdir -p "${WORK}"
SOCKET="${WORK}/firecracker.sock"
rm -f "${SOCKET}" "${MEM}" "${VM}"

cleanup() {
  "${SNAPSHOT_CNI_BIN}" del "${CNI_NETWORK}" "${CONTAINER_ID}" >/dev/null 2>&1 || true
  kill "${FC_PID:-}" 2>/dev/null || true
  wait "${FC_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

echo "setting up CNI for snapshot build (${CONTAINER_ID})..."
NET_JSON="$("${SNAPSHOT_CNI_BIN}" add "${CNI_NETWORK}" "${CONTAINER_ID}")"
TAP_DEVICE="$(echo "${NET_JSON}" | jq -r .tapDevice)"
GUEST_MAC="$(echo "${NET_JSON}" | jq -r .macAddr)"
GUEST_IP="$(echo "${NET_JSON}" | jq -r .guestIP)"
if [[ -z "${TAP_DEVICE}" || "${TAP_DEVICE}" == "null" ]]; then
  echo "failed to create tap device via CNI" >&2
  exit 1
fi

echo "starting firecracker to create golden snapshot for ${RUNTIME} (${VCPU_COUNT} vCPU / ${MEM_SIZE_MIB} MiB)..."
ip netns exec "${CONTAINER_ID}" "${FC_BIN}" --api-sock "${SOCKET}" &
FC_PID=$!

for _ in $(seq 1 30); do
  [[ -S "${SOCKET}" ]] && break
  sleep 0.2
done

curl -fsS --unix-socket "${SOCKET}" -X PUT "http://localhost/machine-config" \
  -H 'Content-Type: application/json' \
  -d "{\"vcpu_count\":${VCPU_COUNT},\"mem_size_mib\":${MEM_SIZE_MIB},\"smt\":false}" >/dev/null

# Configure guest eth0 before init runs; ptp CNI peers the host at 192.168.127.1.
HOST_GW="$(ip route get "${GUEST_IP}" 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
if [[ -z "${HOST_GW}" ]]; then
  HOST_GW="192.168.127.1"
fi
IP_BOOTARG="ip=${GUEST_IP}::${HOST_GW}:255.255.255.0::eth0:off"
BOOT_ARGS="console=ttyS0 reboot=k panic=1 pci=off ${IP_BOOTARG} init=/usr/local/bin/devin-runtime-supervisor"

curl -fsS --unix-socket "${SOCKET}" -X PUT "http://localhost/boot-source" \
  -H 'Content-Type: application/json' \
  -d "{\"kernel_image_path\":\"${KERNEL}\",\"boot_args\":\"${BOOT_ARGS}\"}" >/dev/null

curl -fsS --unix-socket "${SOCKET}" -X PUT "http://localhost/drives/root" \
  -H 'Content-Type: application/json' \
  -d "{\"drive_id\":\"root\",\"path_on_host\":\"${ROOTFS}\",\"is_root_device\":true,\"is_read_only\":false}" >/dev/null

curl -fsS --unix-socket "${SOCKET}" -X PUT "http://localhost/network-interfaces/eth0" \
  -H 'Content-Type: application/json' \
  -d "{\"iface_id\":\"eth0\",\"guest_mac\":\"${GUEST_MAC}\",\"host_dev_name\":\"${TAP_DEVICE}\"}" >/dev/null

curl -fsS --unix-socket "${SOCKET}" -X PUT "http://localhost/actions" \
  -H 'Content-Type: application/json' \
  -d '{"action_type":"InstanceStart"}' >/dev/null

for _ in $(seq 1 10); do
  if ip netns exec "${CONTAINER_ID}" ip link set "${TAP_DEVICE}" up 2>/dev/null; then
    state="$(ip netns exec "${CONTAINER_ID}" ip -o link show "${TAP_DEVICE}" 2>/dev/null | awk '{print $9}')"
    [[ "${state}" == "UP" ]] && break
  fi
  sleep 0.2
done

echo "waiting for runtime supervisor to become healthy at http://${GUEST_IP}:${RUNTIME_PORT}/health ..."
for _ in $(seq 1 60); do
  if curl -sf --max-time 2 "http://${GUEST_IP}:${RUNTIME_PORT}/health" >/dev/null; then
    break
  fi
  sleep 1
done
if ! curl -sf --max-time 2 "http://${GUEST_IP}:${RUNTIME_PORT}/health" >/dev/null; then
  echo "runtime did not become healthy on ${GUEST_IP}:${RUNTIME_PORT}" >&2
  exit 1
fi

curl -fsS --unix-socket "${SOCKET}" -X PATCH "http://localhost/vm" \
  -H 'Content-Type: application/json' \
  -d '{"state":"Paused"}' >/dev/null

curl -fsS --unix-socket "${SOCKET}" -X PUT "http://localhost/snapshot/create" \
  -H 'Content-Type: application/json' \
  -d "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"${VM}\",\"mem_file_path\":\"${MEM}\"}" >/dev/null

cat >"${META}" <<EOF
{
  "runtime": "${RUNTIME}",
  "version": "v1",
  "runtimePort": ${RUNTIME_PORT},
  "vcpuCount": ${VCPU_COUNT},
  "memSizeMib": ${MEM_SIZE_MIB},
  "guestIP": "${GUEST_IP}",
  "networkIfaceId": "eth0",
  "rootfsPath": "${ROOTFS}",
  "memPath": "${MEM}",
  "snapshotPath": "${VM}"
}
EOF

echo "snapshot ready:"
echo "  meta: ${META}"
echo "  mem:  ${MEM}"
echo "  vm:   ${VM}"
echo "  guestIP: ${GUEST_IP}"
