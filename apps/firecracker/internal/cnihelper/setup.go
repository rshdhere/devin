package cnihelper

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/containernetworking/cni/libcni"
	"github.com/containernetworking/cni/pkg/types"
	"github.com/containernetworking/plugins/pkg/ns"
	"github.com/firecracker-microvm/firecracker-go-sdk/cni/vmconf"
	"golang.org/x/sys/unix"
)

type Network struct {
	TapDevice string
	GuestIP   net.IP
	MacAddr   string
	NetNS     string
	cleanup   []func() error
}

func (n *Network) Cleanup() {
	for i := len(n.cleanup) - 1; i >= 0; i-- {
		if err := n.cleanup[i](); err != nil {
			fmt.Fprintf(os.Stderr, "cni cleanup: %v\n", err)
		}
	}
}

type Config struct {
	NetworkName string
	ConfDir     string
	BinPath     string
	GuestIP     string
}

func Add(ctx context.Context, containerID string, cfg Config) (*Network, error) {
	containerID = strings.TrimSpace(containerID)
	if containerID == "" {
		return nil, fmt.Errorf("container id is required")
	}

	networkName := firstNonEmpty(cfg.NetworkName, "fcnet")
	confDir := firstNonEmpty(cfg.ConfDir, "/etc/cni/conf.d")
	binPath := firstNonEmpty(cfg.BinPath, "/opt/cni/bin")
	netNSPath := filepath.Join("/var/run/netns", containerID)

	cleanup, err := initializeNetNS(netNSPath)
	if err != nil {
		return nil, err
	}

	cniPlugin := libcni.NewCNIConfigWithCacheDir([]string{binPath}, filepath.Join("/var/lib/cni", containerID), nil)
	networkConf, err := libcni.LoadConfList(confDir, networkName)
	if err != nil {
		runCleanup(cleanup)
		return nil, fmt.Errorf("load cni config %q: %w", networkName, err)
	}

	runtimeConf := &libcni.RuntimeConf{
		ContainerID: containerID,
		NetNS:       netNSPath,
		IfName:      "veth0",
	}
	if ip := strings.TrimSpace(cfg.GuestIP); ip != "" {
		if !strings.Contains(ip, "/") {
			ip += "/24"
		}
		runtimeConf.Args = [][2]string{{"IP", ip}}
	}

	delNetwork := func() error {
		if err := cniPlugin.DelNetworkList(ctx, networkConf, runtimeConf); err != nil {
			return fmt.Errorf("delete cni network: %w", err)
		}
		return nil
	}
	_ = delNetwork()
	cleanup = append(cleanup, delNetwork)

	result, err := cniPlugin.AddNetworkList(ctx, networkConf, runtimeConf)
	if err != nil {
		runCleanup(cleanup)
		return nil, fmt.Errorf("add cni network: %w", err)
	}

	vmNetConf, err := vmconf.StaticNetworkConfFrom(result, containerID)
	if err != nil {
		runCleanup(cleanup)
		return nil, fmt.Errorf("parse cni result: %w", err)
	}

	net := &Network{
		TapDevice: vmNetConf.TapName,
		MacAddr:   vmNetConf.VMMacAddr,
		NetNS:     netNSPath,
		cleanup:   cleanup,
	}
	if vmNetConf.VMIPConfig != nil {
		net.GuestIP = vmNetConf.VMIPConfig.Address.IP
	}
	return net, nil
}

func initializeNetNS(netNSPath string) ([]func() error, error) {
	var cleanup []func() error

	switch err := ns.IsNSorErr(netNSPath); err.(type) {
	case nil:
		return cleanup, nil
	case ns.NSPathNotNSErr:
		return nil, fmt.Errorf("path %q exists but is not a netns", netNSPath)
	case ns.NSPathNotExistErr:
	default:
		return nil, fmt.Errorf("check netns %q: %w", netNSPath, err)
	}

	parentDir := filepath.Dir(netNSPath)
	if _, err := os.Stat(parentDir); os.IsNotExist(err) {
		if err := os.MkdirAll(parentDir, 0o700); err != nil {
			return nil, fmt.Errorf("create netns parent dir: %w", err)
		}
		cleanup = append(cleanup, func() error {
			return os.Remove(parentDir)
		})
	} else if err != nil {
		return nil, fmt.Errorf("stat netns parent dir: %w", err)
	}

	fd, err := os.OpenFile(netNSPath, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		runCleanup(cleanup)
		return nil, fmt.Errorf("create netns file: %w", err)
	}
	fd.Close()
	cleanup = append(cleanup, func() error {
		return os.Remove(netNSPath)
	})

	done := make(chan error)
	go func() {
		defer close(done)
		runtime.LockOSThread()
		if err := unix.Unshare(unix.CLONE_NEWNET); err != nil {
			done <- fmt.Errorf("unshare netns: %w", err)
			return
		}
		if err := unix.Mount("/proc/thread-self/ns/net", netNSPath, "none", unix.MS_BIND, ""); err != nil {
			done <- fmt.Errorf("mount netns: %w", err)
			return
		}
		cleanup = append(cleanup, func() error {
			return unix.Unmount(netNSPath, unix.MNT_DETACH)
		})
	}()

	if err := <-done; err != nil {
		runCleanup(cleanup)
		return nil, err
	}
	return cleanup, nil
}

func runCleanup(cleanup []func() error) {
	for i := len(cleanup) - 1; i >= 0; i-- {
		_ = cleanup[i]()
	}
}

func Delete(ctx context.Context, containerID string, cfg Config) error {
	networkName := firstNonEmpty(cfg.NetworkName, "fcnet")
	confDir := firstNonEmpty(cfg.ConfDir, "/etc/cni/conf.d")
	binPath := firstNonEmpty(cfg.BinPath, "/opt/cni/bin")
	netNSPath := filepath.Join("/var/run/netns", containerID)

	cniPlugin := libcni.NewCNIConfigWithCacheDir([]string{binPath}, filepath.Join("/var/lib/cni", containerID), nil)
	networkConf, err := libcni.LoadConfList(confDir, networkName)
	if err != nil {
		return fmt.Errorf("load cni config %q: %w", networkName, err)
	}

	runtimeConf := &libcni.RuntimeConf{
		ContainerID: containerID,
		NetNS:       netNSPath,
		IfName:      "veth0",
	}
	if ip := strings.TrimSpace(cfg.GuestIP); ip != "" {
		if !strings.Contains(ip, "/") {
			ip += "/24"
		}
		runtimeConf.Args = [][2]string{{"IP", ip}}
	}

	if err := cniPlugin.DelNetworkList(ctx, networkConf, runtimeConf); err != nil {
		return fmt.Errorf("delete cni network: %w", err)
	}
	_ = os.Remove(netNSPath)
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func SetLinkUp(device string) error {
	return setLinkUp([]string{"ip", "link", "set", device, "up"})
}

func SetLinkUpInNetNS(netns, device string) error {
	return setLinkUp([]string{"ip", "netns", "exec", netns, "ip", "link", "set", device, "up"})
}

func setLinkUp(args []string) error {
	cmd := exec.Command(args[0], args[1:]...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// GuestIPArgs converts a stored guest IP into CNI runtime args.
func GuestIPArgs(guestIP string) [][2]string {
	ip := strings.TrimSpace(guestIP)
	if ip == "" {
		return nil
	}
	if !strings.Contains(ip, "/") {
		ip += "/24"
	}
	return [][2]string{{"IP", ip}}
}

// CleanupStaleAllocations removes orphaned CNI state from /var/lib/cni.
// This is useful when VMs crash or timeout without proper cleanup, leaving
// host-local IPAM to think IPs are still allocated.
func CleanupStaleAllocations(networkName string) error {
	cniStateDir := "/var/lib/cni"

	entries, err := os.ReadDir(cniStateDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read cni state dir: %w", err)
	}

	netNSDir := "/var/run/netns"
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		containerID := entry.Name()
		netNSPath := filepath.Join(netNSDir, containerID)

		switch err := ns.IsNSorErr(netNSPath); err.(type) {
		case nil:
			continue
		case ns.NSPathNotExistErr:
			statePath := filepath.Join(cniStateDir, containerID)
			slog.Debug("cleaning up stale cni allocation", "containerID", containerID, "path", statePath)
			if rmErr := os.RemoveAll(statePath); rmErr != nil {
				slog.Warn("failed to remove stale cni state", "containerID", containerID, "error", rmErr)
			}
		default:
		}
	}

	hostLocalStateDir := filepath.Join(cniStateDir, "networks", networkName)
	if _, err := os.Stat(hostLocalStateDir); err == nil {
		if err := cleanupOrphanedHostLocalIPs(hostLocalStateDir, netNSDir); err != nil {
			slog.Warn("failed to clean orphaned host-local IPs", "error", err)
		}
	}

	return nil
}

func cleanupOrphanedHostLocalIPs(stateDir, netNSDir string) error {
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ipFile := filepath.Join(stateDir, entry.Name())
		data, err := os.ReadFile(ipFile)
		if err != nil {
			continue
		}

		containerID := strings.TrimSpace(string(data))
		if containerID == "" {
			continue
		}

		netNSPath := filepath.Join(netNSDir, containerID)
		switch err := ns.IsNSorErr(netNSPath); err.(type) {
		case nil:
			continue
		case ns.NSPathNotExistErr:
			slog.Debug("releasing orphaned IP allocation", "ip", entry.Name(), "containerID", containerID)
			_ = os.Remove(ipFile)
		}
	}
	return nil
}

// Ensure types.Result is referenced for libcni compatibility.
var _ types.Result
