package pool

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	"github.com/rshdhere/devin/apps/firecracker/internal/cnihelper"
	"github.com/rshdhere/devin/apps/firecracker/internal/config"
	"github.com/rshdhere/devin/apps/firecracker/internal/snapshot"
	"github.com/rshdhere/devin/apps/firecracker/internal/vm"
)

type VMRecord struct {
	VMID       string `json:"vmId"`
	Name       string `json:"name"`
	Host       string `json:"host"`
	Runtime    string `json:"runtime"`
	RuntimeURL string `json:"runtimeURL"`
	Phase      string `json:"phase"`
	Message    string `json:"message,omitempty"`
}

type WarmRuntimeStatus struct {
	Runtime       string `json:"runtime"`
	ReadyVMs      int    `json:"readyVMs"`
	LastWarmError string `json:"lastWarmError,omitempty"`
}

type HostStatus struct {
	Host              string              `json:"host"`
	CapacityCPU       int32               `json:"capacityCPU"`
	CapacityMem       string              `json:"capacityMemory"`
	UsedCPU           int32               `json:"usedCPU"`
	UsedMemory        string              `json:"usedMemory"`
	ReadyVMs          int                 `json:"readyVMs"`
	ActiveVMs         int                 `json:"activeVMs"`
	DefaultRun        string              `json:"defaultRuntime"`
	AvailableRuntimes []string            `json:"availableRuntimes,omitempty"`
	WarmRuntimes      []WarmRuntimeStatus `json:"warmRuntimes,omitempty"`
	LastWarmError     string              `json:"lastWarmError,omitempty"`
}

type Manager struct {
	cfg      config.Config
	launcher *vm.Launcher
	hostName string

	mu                sync.RWMutex
	vms               map[string]*vm.Instance
	assigned          map[string]*vm.Instance
	vmCPU             map[string]int32
	ready             map[string]chan *vm.Instance
	readyCount        int
	usedCPU           int32
	warmErrors        map[string]string
	availableRuntimes []string
}

func NewManager(cfg config.Config) (*Manager, error) {
	if err := cfg.ValidateProduction(); err != nil {
		return nil, err
	}

	m := &Manager{
		cfg:        cfg,
		hostName:   cfg.HostName,
		vms:        make(map[string]*vm.Instance),
		assigned:   make(map[string]*vm.Instance),
		vmCPU:      make(map[string]int32),
		ready:      make(map[string]chan *vm.Instance),
		warmErrors: make(map[string]string),
	}

	if cfg.DryRun {
		m.readyCount = cfg.PoolSize
		return m, nil
	}

	store := snapshot.NewStore(cfg.SnapshotDir, cfg.KernelPath, cfg.RuntimePort, cfg.WarmVCPU, cfg.WarmMemoryMiB)
	m.launcher = vm.NewLauncher(cfg, store)
	m.launcher.SetActiveIDs(func() map[string]struct{} {
		m.mu.RLock()
		defer m.mu.RUnlock()
		keep := make(map[string]struct{}, len(m.vms))
		for id := range m.vms {
			keep[id] = struct{}{}
		}
		return keep
	})
	return m, nil
}

func (m *Manager) snapshotStore() *snapshot.Store {
	return snapshot.NewStore(m.cfg.SnapshotDir, m.cfg.KernelPath, m.cfg.RuntimePort, m.cfg.WarmVCPU, m.cfg.WarmMemoryMiB)
}

func (m *Manager) Start(ctx context.Context) {
	if m.cfg.DryRun {
		go m.warmDryRunPool(ctx)
		return
	}

	if err := cnihelper.PrepareCNIEnvironment(m.cfg.CNIConfDir, m.cfg.CNINetworkName); err != nil {
		slog.Warn("failed to prepare cni environment on startup", "error", err)
	} else {
		slog.Info("prepared cni environment on startup")
	}

	// Drop leftover per-VM rootfs copies from prior process crashes / restarts
	// so golden rootfs clones do not fail with host ENOSPC.
	if removed, err := vm.PruneOrphanVMDirs(m.cfg.VMMDir, nil); err != nil {
		slog.Warn("failed to prune orphan vm dirs on startup", "error", err)
	} else if removed > 0 {
		slog.Info("pruned orphan vm dirs on startup", "removed", removed, "vmmDir", m.cfg.VMMDir)
	}

	runtimes, err := m.snapshotStore().ListRuntimes()
	if err != nil {
		slog.Error("failed to list snapshot runtimes", "error", err)
		runtimes = []string{m.cfg.DefaultRuntime}
	}
	if len(runtimes) == 0 {
		runtimes = []string{m.cfg.DefaultRuntime}
	}

	m.mu.Lock()
	m.availableRuntimes = append([]string(nil), runtimes...)
	m.mu.Unlock()

	warmRuntime := m.cfg.DefaultRuntime
	if !containsRuntime(runtimes, warmRuntime) {
		warmRuntime = runtimes[0]
	}
	queue := make(chan *vm.Instance, m.cfg.PoolSize)
	m.mu.Lock()
	m.ready[warmRuntime] = queue
	m.mu.Unlock()
	go m.warmRuntimePool(ctx, warmRuntime, queue)
	slog.Info("warming microvm pool", "runtime", warmRuntime, "poolSize", m.cfg.PoolSize)
}


func (m *Manager) Get(vmID string) (*VMRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if instance, ok := m.vms[vmID]; ok {
		return m.recordFromInstance(instance), nil
	}
	if m.cfg.DryRun {
		return nil, fmt.Errorf("vm %s not found", vmID)
	}
	return nil, fmt.Errorf("vm %s not found", vmID)
}

func (m *Manager) Delete(vmID string) error {
	m.mu.Lock()
	instance, ok := m.vms[vmID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("vm %s not found", vmID)
	}
	cpu := m.vmCPU[vmID]
	delete(m.vms, vmID)
	delete(m.assigned, vmID)
	delete(m.vmCPU, vmID)
	if m.usedCPU >= cpu {
		m.usedCPU -= cpu
	}
	m.mu.Unlock()

	if m.cfg.DryRun {
		m.mu.Lock()
		m.readyCount++
		m.mu.Unlock()
		return nil
	}

	if err := instance.Shutdown(context.Background()); err != nil {
		slog.Warn("failed to shutdown microVM", "vmId", vmID, "error", err)
	}
	return nil
}

func (m *Manager) ReadyVMs() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.readyCount
}

func (m *Manager) Status() HostStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()

	warmRuntimes := make([]WarmRuntimeStatus, 0, len(m.ready))
	var lastWarmError string
	for runtime, queue := range m.ready {
		status := WarmRuntimeStatus{Runtime: runtime, ReadyVMs: len(queue)}
		if warmErr, ok := m.warmErrors[runtime]; ok {
			status.LastWarmError = warmErr
			if lastWarmError == "" {
				lastWarmError = fmt.Sprintf("%s: %s", runtime, warmErr)
			}
		}
		warmRuntimes = append(warmRuntimes, status)
	}

	available := append([]string(nil), m.availableRuntimes...)

	return HostStatus{
		Host:              m.hostName,
		CapacityCPU:       m.cfg.CapacityCPU,
		CapacityMem:       m.cfg.CapacityMemory,
		UsedCPU:           m.usedCPU,
		UsedMemory:        formatUsedMemoryMiB(m.estimatedUsedMemoryMiB()),
		ReadyVMs:          m.readyCount,
		ActiveVMs:         len(m.assigned),
		DefaultRun:        m.cfg.DefaultRuntime,
		AvailableRuntimes: available,
		WarmRuntimes:      warmRuntimes,
		LastWarmError:     lastWarmError,
	}
}

func (m *Manager) recordFromInstance(instance *vm.Instance) *VMRecord {
	return &VMRecord{
		VMID:       instance.ID,
		Name:       instance.Name,
		Host:       m.hostName,
		Runtime:    instance.Runtime,
		RuntimeURL: instance.RuntimeURL,
		Phase:      instance.Phase,
		Message:    instance.Message,
	}
}

func (m *Manager) estimatedUsedMemoryMiB() int32 {
	vcpu := m.cfg.WarmVCPU
	if vcpu < 1 {
		vcpu = 1
	}
	perCPU := m.cfg.WarmMemoryMiB / int64(vcpu)
	if perCPU < 1 {
		perCPU = 1
	}
	return int32(int64(m.usedCPU) * perCPU)
}

func formatUsedMemoryMiB(mib int32) string {
	if mib >= 1024 {
		return fmt.Sprintf("%dGi", mib/1024)
	}
	return fmt.Sprintf("%dMi", mib)
}

func containsRuntime(runtimes []string, runtime string) bool {
	for _, candidate := range runtimes {
		if candidate == runtime {
			return true
		}
	}
	return false
}
