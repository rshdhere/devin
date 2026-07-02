package workspace

import (
	"log/slog"
	"os"
	"runtime"
	"strings"
)

const defaultResolvConf = `nameserver 8.8.8.8
nameserver 1.1.1.1
nameserver 8.8.4.4
`

// EnsureDNS always writes public resolvers for sandbox egress.
// Firecracker guests inherit host/VPC resolvers (via CNI or snapshots) that are
// often unreachable inside the microVM NAT namespace — e.g. 169.254.169.253 or
// the VPC DNS at the subnet base. Public resolvers work through ipMasq NAT.
func EnsureDNS() {
	if runtime.GOOS != "linux" {
		return
	}

	if err := os.WriteFile("/etc/resolv.conf", []byte(defaultResolvConf), 0o644); err != nil {
		slog.Warn("failed to configure guest DNS", "error", err)
		return
	}

	slog.Info("configured guest DNS resolvers for sandbox egress")
}

// hasUnreachableNameserver detects resolvers copied from the execution host that
// microVM guests cannot reach. Used only by tests.
func hasUnreachableNameserver(content string) bool {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "nameserver ") {
			continue
		}
		server := strings.TrimSpace(strings.TrimPrefix(line, "nameserver "))
		if server == "" || server == "127.0.0.53" || server == "127.0.0.1" {
			continue
		}
		if strings.HasPrefix(server, "169.254.") {
			return true
		}
	}
	return false
}
