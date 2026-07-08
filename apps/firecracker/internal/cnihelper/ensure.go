package cnihelper

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/containernetworking/plugins/pkg/ns"
)

// staticFCNetConflist is the canonical fcnet config. Keep in sync with
// apps/firecracker/config/cni/fcnet.conflist.
const staticFCNetConflist = `{
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
`

// PrepareCNIEnvironment migrates legacy host-local IPAM config to static IPAM,
// clears obsolete host-local allocation state, and removes stale container dirs.
func PrepareCNIEnvironment(confDir, networkName string) error {
	confDir = firstNonEmpty(confDir, "/etc/cni/conf.d")
	networkName = firstNonEmpty(networkName, "fcnet")

	if err := ensureStaticIPAMConfig(confDir, networkName); err != nil {
		return err
	}
	if err := removeLegacyHostLocalState(networkName); err != nil {
		return err
	}
	if err := cleanupOrphanedNetNS(networkName, confDir, firstNonEmpty(os.Getenv("FIRECRACKER_CNI_BIN_PATH"), "/opt/cni/bin")); err != nil {
		return err
	}
	if err := cleanupStaleCNIChains(); err != nil {
		slog.Warn("failed to clean stale cni iptables chains", "error", err)
	}
	return CleanupStaleAllocations(networkName)
}

func ensureStaticIPAMConfig(confDir, networkName string) error {
	confPath := filepath.Join(confDir, networkName+".conflist")
	data, err := os.ReadFile(confPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read cni config %q: %w", confPath, err)
	}

	needsWrite := err != nil || strings.Contains(string(data), `"type": "host-local"`)
	if !needsWrite {
		return nil
	}

	if err := os.MkdirAll(confDir, 0o755); err != nil {
		return fmt.Errorf("create cni config dir: %w", err)
	}
	if err := os.WriteFile(confPath, []byte(staticFCNetConflist), 0o644); err != nil {
		return fmt.Errorf("write static cni config %q: %w", confPath, err)
	}

	slog.Info("installed static cni ipam config", "path", confPath)
	return nil
}

func removeLegacyHostLocalState(networkName string) error {
	legacyDir := filepath.Join("/var/lib/cni/networks", networkName)
	if _, err := os.Stat(legacyDir); os.IsNotExist(err) {
		return nil
	}
	if err := os.RemoveAll(legacyDir); err != nil {
		return fmt.Errorf("remove legacy host-local state %q: %w", legacyDir, err)
	}
	slog.Info("removed legacy host-local cni ipam state", "path", legacyDir)
	return nil
}

func cleanupOrphanedNetNS(networkName, confDir, binPath string) error {
	netNSDir := "/var/run/netns"
	entries, err := os.ReadDir(netNSDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read netns dir: %w", err)
	}

	ctx := context.Background()
	cfg := Config{
		NetworkName: networkName,
		ConfDir:     confDir,
		BinPath:     binPath,
	}

	var cleaned int
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		containerID := entry.Name()
		switch err := ns.IsNSorErr(filepath.Join(netNSDir, containerID)); err.(type) {
		case nil:
		default:
			continue
		}

		if err := Delete(ctx, containerID, cfg); err != nil {
			slog.Debug("cni delete during netns cleanup failed", "containerID", containerID, "error", err)
		}
		if err := os.Remove(filepath.Join(netNSDir, containerID)); err != nil && !os.IsNotExist(err) {
			slog.Warn("failed to remove orphaned netns", "containerID", containerID, "error", err)
			continue
		}
		statePath := filepath.Join("/var/lib/cni", containerID)
		_ = os.RemoveAll(statePath)
		cleaned++
	}

	if cleaned > 0 {
		slog.Info("removed orphaned microvm network namespaces", "count", cleaned)
	}
	return nil
}

func cleanupStaleCNIChains() error {
	out, err := exec.Command("iptables", "-t", "nat", "-S").CombinedOutput()
	if err != nil {
		return fmt.Errorf("list nat chains: %w: %s", err, strings.TrimSpace(string(out)))
	}

	var chains []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "-N CNI-") {
			chains = append(chains, strings.Fields(line)[1])
		}
	}

	var cleaned int
	for _, chain := range chains {
		_ = exec.Command("iptables", "-t", "nat", "-F", chain).Run()
		if err := exec.Command("iptables", "-t", "nat", "-X", chain).Run(); err == nil {
			cleaned++
		}
	}
	if cleaned > 0 {
		slog.Info("removed stale cni iptables chains", "count", cleaned)
	}
	return nil
}
