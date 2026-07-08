package pool

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/rs/xid"

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

	// Static CNI IPAM pins the host-side ptp peer to 192.168.127.1, so only one
	// microVM network can be active per host. Warm the default runtime only.
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

func (m *Manager) warmDryRunPool(ctx context.Context) {
	for i := 0; i < m.cfg.PoolSize; i++ {
		select {
		case <-ctx.Done():
			return
		default:
			m.mu.Lock()
			m.readyCount++
			m.mu.Unlock()
			time.Sleep(100 * time.Millisecond)
		}
	}
}

func (m *Manager) warmRuntimePool(ctx context.Context, runtime string, queue chan *vm.Instance) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if len(queue) >= m.cfg.PoolSize {
			time.Sleep(time.Second)
			continue
		}

		instance, err := m.launchWarm(ctx, runtime)
		if err != nil {
			slog.Error("failed to warm microVM", "runtime", runtime, "error", err)
			m.mu.Lock()
			m.warmErrors[runtime] = err.Error()
			m.mu.Unlock()
			time.Sleep(5 * time.Second)
			continue
		}

		m.mu.Lock()
		delete(m.warmErrors, runtime)
		m.mu.Unlock()

		select {
		case <-ctx.Done():
			_ = instance.Shutdown(context.Background())
			return
		case queue <- instance:
			m.mu.Lock()
			m.readyCount++
			m.mu.Unlock()
			slog.Info("warmed microVM", "runtime", runtime, "vmId", instance.ID, "runtimeURL", instance.RuntimeURL)
		}
	}
}

func (m *Manager) launchWarm(ctx context.Context, runtime string) (*vm.Instance, error) {
	vmID := xid.New().String()
	instance, err := m.launcher.Restore(
		ctx,
		vmID,
		"warm-"+vmID,
		runtime,
		m.cfg.WarmVCPU,
		fmt.Sprintf("%dMi", m.cfg.WarmMemoryMiB),
	)
	if err != nil && isCNIAllocationError(err) {
		slog.Warn("CNI allocation failed, cleaning stale state and retrying", "vmId", vmID, "error", err)
		if cleanErr := cnihelper.PrepareCNIEnvironment(m.cfg.CNIConfDir, m.cfg.CNINetworkName); cleanErr != nil {
			slog.Warn("failed to prepare cni environment after allocation failure", "error", cleanErr)
		}
		vmID = xid.New().String()
		instance, err = m.launcher.Restore(
			ctx,
			vmID,
			"warm-"+vmID,
			runtime,
			m.cfg.WarmVCPU,
			fmt.Sprintf("%dMi", m.cfg.WarmMemoryMiB),
		)
	}
	return instance, err
}

func (m *Manager) Create(name, runtime, taskID string, cpu int32, memory string) (*VMRecord, error) {
	_ = taskID

	if runtime == "" {
		runtime = m.cfg.DefaultRuntime
	}

	if m.cfg.DryRun {
		return m.createDryRun(name, runtime)
	}

	if err := m.validateRuntime(runtime); err != nil {
		return nil, err
	}

	if warm, ok := m.takeWarm(runtime, name); ok {
		m.mu.Lock()
		m.assigned[warm.ID] = warm
		m.vms[warm.ID] = warm
		m.vmCPU[warm.ID] = cpu
		m.usedCPU += cpu
		m.mu.Unlock()
		return m.recordFromInstance(warm), nil
	}

	vmID := xid.New().String()
	pending := &vm.Instance{
		ID:      vmID,
		Name:    name,
		Runtime: runtime,
		Phase:   "Provisioning",
		Message: "restoring snapshot",
	}

	m.mu.Lock()
	m.vms[vmID] = pending
	m.mu.Unlock()

	go m.provisionCold(vmID, name, runtime, cpu, memory)

	return m.recordFromInstance(pending), nil
}

func (m *Manager) createDryRun(name, runtime string) (*VMRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	vmID := xid.New().String()
	record := &VMRecord{
		VMID:       vmID,
		Name:       name,
		Host:       m.hostName,
		Runtime:    runtime,
		RuntimeURL: m.cfg.RuntimeFallback,
		Phase:      "Running",
		Message:    "dry-run microVM assigned from warm pool",
	}
	m.vms[vmID] = &vm.Instance{
		ID:         vmID,
		Name:       name,
		Runtime:    runtime,
		RuntimeURL: m.cfg.RuntimeFallback,
		Phase:      "Running",
		Message:    record.Message,
	}
	if m.readyCount > 0 {
		m.readyCount--
	}
	return record, nil
}

func (m *Manager) validateRuntime(runtime string) error {
	if _, err := m.snapshotStore().Resolve(runtime); err != nil {
		return fmt.Errorf("runtime %q is not provisioned on this host: %w", runtime, err)
	}
	return nil
}

func (m *Manager) takeWarm(runtime, name string) (*vm.Instance, bool) {
	m.mu.RLock()
	queue := m.ready[runtime]
	m.mu.RUnlock()

	if queue == nil {
		return nil, false
	}

	select {
	case warm := <-queue:
		m.mu.Lock()
		if m.readyCount > 0 {
			m.readyCount--
		}
		m.mu.Unlock()
		warm.Name = name
		warm.Message = "assigned from warm pool"
		return warm, true
	default:
		return nil, false
	}
}

func (m *Manager) provisionCold(vmID, name, runtime string, cpu int32, memory string) {
	ctx := context.Background()
	instance, err := m.launcher.Restore(ctx, vmID, name, runtime, cpu, memory)

	if err != nil && isCNIAllocationError(err) {
		slog.Warn("CNI allocation failed during cold provision, cleaning stale state and retrying",
			"vmId", vmID, "error", err)
		if cleanErr := cnihelper.PrepareCNIEnvironment(m.cfg.CNIConfDir, m.cfg.CNINetworkName); cleanErr != nil {
			slog.Warn("failed to prepare cni environment after allocation failure", "error", cleanErr)
		}
		newVMID := xid.New().String()
		m.mu.Lock()
		if pending, ok := m.vms[vmID]; ok {
			pending.Message = "retrying after CNI cleanup"
			m.vms[newVMID] = pending
			delete(m.vms, vmID)
		}
		m.mu.Unlock()
		vmID = newVMID
		instance, err = m.launcher.Restore(ctx, vmID, name, runtime, cpu, memory)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	pending, ok := m.vms[vmID]
	if !ok {
		if err == nil {
			_ = instance.Shutdown(ctx)
		}
		return
	}

	if err != nil {
		pending.Phase = "Failed"
		pending.Message = err.Error()
		return
	}

	m.assigned[instance.ID] = instance
	m.vms[instance.ID] = instance
	m.vmCPU[instance.ID] = cpu
	m.usedCPU += cpu
	if instance.ID != vmID {
		delete(m.vms, vmID)
	}
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
		UsedMemory:        formatUsedMemoryMiB(m.usedCPU * 512),
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

func formatUsedMemoryMiB(mib int32) string {
	if mib >= 1024 {
		return fmt.Sprintf("%dGi", mib/1024)
	}
	return fmt.Sprintf("%dMi", mib)
}

func isCNIAllocationError(err error) bool {
	if err == nil {
		return false
	}
	errStr := err.Error()
	return strings.Contains(errStr, "failed to allocate") ||
		strings.Contains(errStr, "not available in range") ||
		strings.Contains(errStr, "failed to create CNI network") ||
		strings.Contains(errStr, "file exists")
}

func containsRuntime(runtimes []string, runtime string) bool {
	for _, candidate := range runtimes {
		if candidate == runtime {
			return true
		}
	}
	return false
}
