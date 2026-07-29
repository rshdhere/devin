package host

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func FixSandboxDNS(ctx context.Context) error {
	if err := sysutil.MustRoot(); err != nil {
		return err
	}
	if err := sysutil.WriteFile("/etc/cni/resolv.conf", "nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 8.8.4.4\n", 0644); err != nil {
		return err
	}
	if err := sysutil.WriteFile("/etc/cni/conf.d/fcnet.conflist", fcnet+"\n", 0644); err != nil {
		return err
	}
	if err := sysutil.WriteFile("/etc/sysctl.d/99-devin-microvm.conf", "net.ipv4.ip_forward=1\nnet.ipv4.conf.all.rp_filter=0\nnet.ipv4.conf.default.rp_filter=0\n", 0644); err != nil {
		return err
	}
	_ = sysutil.Command(ctx, "sysctl", "--system")
	_ = os.RemoveAll("/var/lib/cni/networks/fcnet")
	if entries, err := os.ReadDir("/var/run/netns"); err == nil {
		for _, e := range entries {
			_ = sysutil.Command(ctx, "ip", "netns", "del", e.Name())
			_ = os.Remove(filepath.Join("/var/run/netns", e.Name()))
			_ = os.RemoveAll(filepath.Join("/var/lib/cni", e.Name()))
		}
	}
	_ = purgeCNINAT(ctx)
	return nil
}

func purgeCNINAT(ctx context.Context) error {
	if _, err := exec.LookPath("iptables"); err != nil {
		return nil
	}
	tmp, err := os.CreateTemp("", "devin-iptables-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	tmp.Close()
	if err := sysutil.Command(ctx, "bash", "-c", fmt.Sprintf(`
set -euo pipefail
iptables-save -t nat >%q
grep -v 'CNI-' %q >%q.clean || cp %q %q.clean
awk -v masq='-A POSTROUTING -s 192.168.127.0/24 -j MASQUERADE' '
  BEGIN { inserted = 0 }
  /^-A POSTROUTING -s 192\.168\.127\.0\/24 -j MASQUERADE$/ { next }
  /^\*nat/ { print; next }
  /^-A POSTROUTING/ && !inserted { print masq; inserted = 1 }
  /^COMMIT/ && !inserted { print masq; inserted = 1 }
  { print }
' %q.clean >%q.final
iptables-restore <%q.final
iptables -C FORWARD -s 192.168.127.0/24 -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -s 192.168.127.0/24 -j ACCEPT
iptables -C FORWARD -d 192.168.127.0/24 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -d 192.168.127.0/24 -m state --state RELATED,ESTABLISHED -j ACCEPT
if iptables -L DOCKER-USER -n >/dev/null 2>&1; then
  iptables -C DOCKER-USER -s 192.168.127.0/24 -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -s 192.168.127.0/24 -j ACCEPT
  iptables -C DOCKER-USER -d 192.168.127.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -d 192.168.127.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
fi
`, tmp.Name(), tmp.Name(), tmp.Name(), tmp.Name(), tmp.Name(), tmp.Name(), tmp.Name(), tmp.Name())); err != nil {
		return err
	}
	if _, err := exec.LookPath("conntrack"); err == nil {
		_ = sysutil.Command(ctx, "conntrack", "-D", "-s", "192.168.127.0/24")
		_ = sysutil.Command(ctx, "conntrack", "-D", "-d", "192.168.127.0/24")
	}
	return nil
}
