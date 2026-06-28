package vm

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	firecracker "github.com/firecracker-microvm/firecracker-go-sdk"
	models "github.com/firecracker-microvm/firecracker-go-sdk/client/models"

	"github.com/rshdhere/devin/apps/firecracker-host/internal/cnihelper"
	"github.com/rshdhere/devin/apps/firecracker-host/internal/config"
	"github.com/rshdhere/devin/apps/firecracker-host/internal/snapshot"
)

type Launcher struct {
	cfg      config.Config
	snapshot *snapshot.Store
}

func NewLauncher(cfg config.Config, snapshotStore *snapshot.Store) *Launcher {
	return &Launcher{cfg: cfg, snapshot: snapshotStore}
}

func (l *Launcher) Restore(ctx context.Context, vmID, name, runtime string, cpu int32, memory string) (*Instance, error) {
	meta, err := l.snapshot.Resolve(runtime)
	if err != nil {
		return nil, err
	}

	memMiB, err := config.ParseMemoryMiB(memory)
	if err != nil {
		return nil, err
	}
	if cpu <= 0 {
		cpu = int32(meta.VcpuCount)
	}
	if memMiB <= 0 {
		memMiB = int64(meta.MemSizeMib)
	}
	if meta.VcpuCount > 0 && int32(meta.VcpuCount) != cpu {
		slog.Warn("restore cpu differs from snapshot metadata, using snapshot value",
			"vmId", vmID, "requested", cpu, "snapshot", meta.VcpuCount)
		cpu = int32(meta.VcpuCount)
	}
	if meta.MemSizeMib > 0 && int64(meta.MemSizeMib) != memMiB {
		slog.Warn("restore memory differs from snapshot metadata, using snapshot value",
			"vmId", vmID, "requested", memMiB, "snapshot", meta.MemSizeMib)
		memMiB = int64(meta.MemSizeMib)
	}

	vmDir := filepath.Join(l.cfg.VMMDir, vmID)
	if err := os.MkdirAll(vmDir, 0o755); err != nil {
		return nil, err
	}

	socketPath := filepath.Join(vmDir, "firecracker.sock")
	logPath := filepath.Join(vmDir, "firecracker.log")

	fcCfg := firecracker.Config{
		VMID:       vmID,
		SocketPath: socketPath,
		LogPath:    logPath,
		Drives: []models.Drive{
			{
				DriveID:      firecracker.String("root"),
				IsRootDevice: firecracker.Bool(true),
				IsReadOnly:   firecracker.Bool(true),
				PathOnHost:   firecracker.String(meta.RootfsPath),
			},
		},
		NetworkInterfaces: firecracker.NetworkInterfaces{
			{
				CNIConfiguration: &firecracker.CNIConfiguration{
					NetworkName: l.cfg.CNINetworkName,
					IfName:      "veth0",
					ConfDir:     l.cfg.CNIConfDir,
					BinPath:     []string{l.cfg.CNIBinPath},
					VMIfName:    meta.NetworkIfaceID,
					Args:        cnihelper.GuestIPArgs(meta.GuestIP),
				},
			},
		},
		MachineCfg: models.MachineConfiguration{
			VcpuCount:  firecracker.Int64(int64(cpu)),
			MemSizeMib: firecracker.Int64(memMiB),
		},
	}

	vmmCtx, cancel := context.WithCancel(ctx)
	cmd := firecracker.VMCommandBuilder{}.
		WithBin(l.cfg.FirecrackerBin).
		WithSocketPath(socketPath).
		Build(vmmCtx)

	machine, err := firecracker.NewMachine(
		vmmCtx,
		fcCfg,
		firecracker.WithProcessRunner(cmd),
		firecracker.WithSnapshot(meta.MemPath, meta.SnapshotPath, func(sc *firecracker.SnapshotConfig) {
			sc.ResumeVM = true
		}),
	)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create firecracker machine: %w", err)
	}

	if err := machine.Start(vmmCtx); err != nil {
		cancel()
		_ = machine.StopVMM()
		return nil, fmt.Errorf("start firecracker machine: %w", err)
	}

	if tapDevice, err := tapDeviceFromMachine(machine); err == nil {
		for attempt := 0; attempt < 10; attempt++ {
			if upErr := cnihelper.SetLinkUpInNetNS(vmID, tapDevice); upErr == nil {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}

	ip, err := machineIP(machine)
	if err != nil {
		cancel()
		_ = machine.StopVMM()
		slog.Error("failed to resolve microVM network after snapshot restore",
			"vmId", vmID, "runtime", runtime, "error", err)
		return nil, err
	}

	runtimeURL := fmt.Sprintf("http://%s:%d", ip.String(), meta.RuntimePort)
	instance := &Instance{
		ID:         vmID,
		Name:       name,
		Runtime:    runtime,
		IP:         ip,
		RuntimeURL: runtimeURL,
		Phase:      "Running",
		Message:    "microVM restored from snapshot",
		machine:    machine,
		cancel:     cancel,
		cniConfig: cnihelper.Config{
			NetworkName: l.cfg.CNINetworkName,
			ConfDir:     l.cfg.CNIConfDir,
			BinPath:     l.cfg.CNIBinPath,
			GuestIP:     meta.GuestIP,
		},
	}

	slog.Info("waiting for runtime health",
		"vmId", vmID,
		"runtime", runtime,
		"runtimeURL", runtimeURL,
	)
	if err := waitForRuntimeHealth(ctx, instance.RuntimeURL, 30*time.Second); err != nil {
		_ = instance.Shutdown(context.Background())
		return nil, fmt.Errorf("runtime health check failed: %w", err)
	}

	return instance, nil
}

func tapDeviceFromMachine(machine *firecracker.Machine) (string, error) {
	if len(machine.Cfg.NetworkInterfaces) == 0 {
		return "", fmt.Errorf("firecracker machine has no network interfaces configured")
	}
	staticCfg := machine.Cfg.NetworkInterfaces[0].StaticConfiguration
	if staticCfg == nil || staticCfg.HostDevName == "" {
		return "", fmt.Errorf("firecracker machine has no tap device from CNI setup")
	}
	return staticCfg.HostDevName, nil
}

func machineIP(machine *firecracker.Machine) (net.IP, error) {
	if len(machine.Cfg.NetworkInterfaces) == 0 {
		return nil, fmt.Errorf("firecracker machine has no network interfaces")
	}
	staticCfg := machine.Cfg.NetworkInterfaces[0].StaticConfiguration
	if staticCfg == nil || staticCfg.IPConfiguration == nil {
		return nil, fmt.Errorf("firecracker machine has no static IP configuration")
	}
	if staticCfg.IPConfiguration.IPAddr.IP == nil {
		return nil, fmt.Errorf("firecracker machine IP is empty")
	}
	return staticCfg.IPConfiguration.IPAddr.IP, nil
}

func waitForRuntimeHealth(ctx context.Context, runtimeURL string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, runtimeURL+"/health", nil)
		if err != nil {
			cancel()
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		cancel()
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 300 {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
	return fmt.Errorf("runtime at %s did not become healthy within %s", runtimeURL, timeout)
}
