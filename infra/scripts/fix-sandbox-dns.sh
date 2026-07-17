#!/usr/bin/env bash
# Apply sandbox DNS fixes on an execution host (CNI resolvers + fcnet config).
# Run on the host as root, or via SSM:
#   sudo ./infra/scripts/fix-sandbox-dns.sh
set -euo pipefail

mkdir -p /etc/cni/conf.d

cat >/etc/cni/resolv.conf <<'RESOLV'
nameserver 8.8.8.8
nameserver 1.1.1.1
nameserver 8.8.4.4
RESOLV

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FCNET_SRC="${REPO_ROOT}/apps/firecracker/config/cni/fcnet.conflist"

if [[ -f "${FCNET_SRC}" ]]; then
  cp "${FCNET_SRC}" /etc/cni/conf.d/fcnet.conflist
else
  cat >/etc/cni/conf.d/fcnet.conflist <<'CNI'
{
  "cniVersion": "0.4.0",
  "name": "fcnet",
  "plugins": [
    {
      "type": "ptp",
      "ipMasq": true,
      "ipam": {
        "type": "static",
        "addresses": [
          {
            "address": "192.168.127.8/24",
            "gateway": "192.168.127.1"
          }
        ],
        "routes": [
          {
            "dst": "0.0.0.0/0"
          }
        ],
        "dns": {
          "nameservers": ["8.8.8.8", "1.1.1.1", "8.8.4.4"]
        }
      }
    },
    {
      "type": "tc-redirect-tap"
    }
  ]
}
CNI
fi

cat >/etc/sysctl.d/99-devin-microvm.conf <<'SYSCTL'
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=0
net.ipv4.conf.default.rp_filter=0
SYSCTL
sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-devin-microvm.conf

echo "CNI DNS configured:"
echo "  /etc/cni/resolv.conf"
echo "  /etc/cni/conf.d/fcnet.conflist"
echo ""
if [[ -d /var/lib/cni/networks/fcnet ]]; then
  echo "Removing legacy host-local IPAM state (static IPAM no longer tracks allocations)..."
  rm -rf /var/lib/cni/networks/fcnet
fi
if [[ -f /etc/cni/conf.d/fcnet.conflist ]] && grep -q '"host-local"' /etc/cni/conf.d/fcnet.conflist; then
  echo "Migrating fcnet CNI config from host-local to static IPAM..."
  cp "${FCNET_SRC}" /etc/cni/conf.d/fcnet.conflist 2>/dev/null || true
fi

if [[ -d /var/run/netns ]]; then
  echo "Removing orphaned microVM network namespaces..."
  for netns_path in /var/run/netns/*; do
    [[ -e "$netns_path" ]] || continue
    container_id="$(basename "$netns_path")"
    CNI_PATH="${CNI_PATH:-/opt/cni/bin}" \
      cnitool del fcnet "$container_id" >/dev/null 2>&1 \
      || /opt/cni/bin/cnitool del fcnet "$container_id" >/dev/null 2>&1 \
      || true
    ip netns del "$container_id" >/dev/null 2>&1 || rm -f "$netns_path"
    rm -rf "${CNI_STATE_DIR}/${container_id}"
  done
fi

if command -v iptables >/dev/null; then
  echo "Purging stale CNI NAT rules and ensuring fcnet MASQUERADE is first"
  # Per-VM CNI POSTROUTING jumps accumulate and can shadow subnet MASQUERADE.
  # Rewrite the nat table without CNI-* rules, then put subnet MASQ first.
  tmp="$(mktemp)"
  iptables-save -t nat >"${tmp}"
  grep -v 'CNI-' "${tmp}" >"${tmp}.clean" || cp "${tmp}" "${tmp}.clean"
  awk -v masq='-A POSTROUTING -s 192.168.127.0/24 -j MASQUERADE' '
    BEGIN { inserted = 0 }
    /^-A POSTROUTING -s 192\.168\.127\.0\/24 -j MASQUERADE$/ { next }
    /^\*nat/ { print; next }
    /^-A POSTROUTING/ && !inserted { print masq; inserted = 1 }
    /^COMMIT/ && !inserted { print masq; inserted = 1 }
    { print }
  ' "${tmp}.clean" >"${tmp}.final"
  iptables-restore <"${tmp}.final"
  rm -f "${tmp}" "${tmp}.clean" "${tmp}.final"

  iptables -C FORWARD -s 192.168.127.0/24 -j ACCEPT 2>/dev/null \
    || iptables -I FORWARD 1 -s 192.168.127.0/24 -j ACCEPT
  iptables -C FORWARD -d 192.168.127.0/24 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
    || iptables -I FORWARD 1 -d 192.168.127.0/24 -m state --state RELATED,ESTABLISHED -j ACCEPT
  # Docker sets FORWARD DROP and evaluates DOCKER-USER first.
  if iptables -L DOCKER-USER -n >/dev/null 2>&1; then
    iptables -C DOCKER-USER -s 192.168.127.0/24 -j ACCEPT 2>/dev/null \
      || iptables -I DOCKER-USER 1 -s 192.168.127.0/24 -j ACCEPT
    iptables -C DOCKER-USER -d 192.168.127.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
      || iptables -I DOCKER-USER 1 -d 192.168.127.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  fi
fi
echo ""
echo "Restart firecracker and rebuild runtime snapshots for full effect:"
echo "  sudo systemctl restart devin-firecracker"
echo "  sudo systemctl restart devin-scheduler"
echo "  sudo DEVIN_REPO_URL=https://github.com/rshdhere/devin.git ./infra/scripts/bootstrap-execution-host-snapshots.sh"
