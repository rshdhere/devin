package pool

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/rs/xid"

	"github.com/rshdhere/devin/apps/firecracker/internal/cnihelper"
	"github.com/rshdhere/devin/apps/firecracker/internal/vm"
)

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

	// Idempotent create: concurrent machine reconciles must not launch duplicate VMs.
	if existing := m.findByName(name); existing != nil {
		return existing, nil
	}

	if err := m.guardCreateCapacity(); err != nil {
		return nil, err
	}

	if warm, ok := m.takeWarm(runtime, name); ok {
		// Warm snapshots are pinned to WarmVCPU; charge that instead of the
		// caller-requested CPU so capacity matches real vCPU usage.
		chargeCPU := m.cfg.WarmVCPU
		if chargeCPU < 1 {
			chargeCPU = 1
		}
		m.mu.Lock()
		if existing := m.findByNameLocked(name); existing != nil {
			// Lost the race to another create; return the warm VM to the pool.
			if queue := m.ready[runtime]; queue != nil {
				select {
				case queue <- warm:
					m.readyCount++
				default:
					go func() { _ = warm.Shutdown(context.Background()) }()
				}
			} else {
				go func() { _ = warm.Shutdown(context.Background()) }()
			}
			m.mu.Unlock()
			return existing, nil
		}
		if err := m.reserveCPULocked(chargeCPU); err != nil {
			if queue := m.ready[runtime]; queue != nil {
				select {
				case queue <- warm:
					m.readyCount++
				default:
					go func() { _ = warm.Shutdown(context.Background()) }()
				}
			} else {
				go func() { _ = warm.Shutdown(context.Background()) }()
			}
			m.mu.Unlock()
			return nil, err
		}
		if err := m.reserveActiveVMLocked(); err != nil {
			if queue := m.ready[runtime]; queue != nil {
				select {
				case queue <- warm:
					m.readyCount++
				default:
					go func() { _ = warm.Shutdown(context.Background()) }()
				}
			} else {
				go func() { _ = warm.Shutdown(context.Background()) }()
			}
			m.mu.Unlock()
			return nil, err
		}
		m.assigned[warm.ID] = warm
		m.vms[warm.ID] = warm
		m.vmCPU[warm.ID] = chargeCPU
		m.usedCPU += chargeCPU
		m.mu.Unlock()
		return m.recordFromInstance(warm), nil
	}

	chargeCPU := cpu
	if chargeCPU < 1 {
		chargeCPU = 1
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
	if existing := m.findByNameLocked(name); existing != nil {
		m.mu.Unlock()
		return existing, nil
	}
	if err := m.reserveCPULocked(chargeCPU); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	if err := m.reserveActiveVMLocked(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	m.vms[vmID] = pending
	m.vmCPU[vmID] = chargeCPU
	m.usedCPU += chargeCPU
	m.mu.Unlock()

	m.drainWarmPool()

	go m.provisionCold(vmID, name, runtime, chargeCPU, memory)

	return m.recordFromInstance(pending), nil
}

func (m *Manager) findByName(name string) *VMRecord {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.findByNameLocked(name)
}

func (m *Manager) findByNameLocked(name string) *VMRecord {
	if name == "" {
		return nil
	}
	for _, instance := range m.vms {
		if instance.Name == name {
			return m.recordFromInstance(instance)
		}
	}
	return nil
}

func (m *Manager) reserveCPULocked(cpu int32) error {
	if m.usedCPU+cpu > m.cfg.CapacityCPU {
		available := m.cfg.CapacityCPU - m.usedCPU
		if available < 0 {
			available = 0
		}
		return fmt.Errorf(
			"host lacks capacity for %d cpu (capacity=%d used=%d available=%d activeVMs=%d)",
			cpu,
			m.cfg.CapacityCPU,
			m.usedCPU,
			available,
			len(m.assigned),
		)
	}
	return nil
}

func (m *Manager) guardCreateCapacity() error {
	if err := vm.GuardMinFreeDisk(m.cfg.VMMDir, m.cfg.MinFreeDiskGiB); err != nil {
		return err
	}
	if m.cfg.MaxActiveVMs <= 0 {
		return nil
	}
	m.mu.RLock()
	n := len(m.vms)
	max := m.cfg.MaxActiveVMs
	m.mu.RUnlock()
	if n >= max {
		return fmt.Errorf("host active VM guardrail: %d/%d microVMs in use", n, max)
	}
	return nil
}

func (m *Manager) reserveActiveVMLocked() error {
	if m.cfg.MaxActiveVMs <= 0 {
		return nil
	}
	if len(m.vms) >= m.cfg.MaxActiveVMs {
		return fmt.Errorf(
			"host active VM guardrail: %d/%d microVMs in use",
			len(m.vms),
			m.cfg.MaxActiveVMs,
		)
	}
	return nil
}

func (m *Manager) List() []*VMRecord {
	m.mu.RLock()
	defer m.mu.RUnlock()

	records := make([]*VMRecord, 0, len(m.assigned))
	for _, instance := range m.assigned {
		records = append(records, m.recordFromInstance(instance))
	}
	return records
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
		cnihelper.FlushGuestConntrack()
		if err := warm.HealthCheck(context.Background()); err != nil {
			slog.Warn("warm microVM failed post-assign health check; shutting down",
				"vmId", warm.ID, "runtime", runtime, "error", err)
			_ = warm.Shutdown(context.Background())
			return nil, false
		}
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
		if reserved := m.vmCPU[vmID]; reserved > 0 && m.usedCPU >= reserved {
			m.usedCPU -= reserved
		}
		delete(m.vmCPU, vmID)
		return
	}

	m.assigned[instance.ID] = instance
	m.vms[instance.ID] = instance
	if instance.ID != vmID {
		m.vmCPU[instance.ID] = m.vmCPU[vmID]
		delete(m.vms, vmID)
		delete(m.vmCPU, vmID)
	} else {
		m.vmCPU[instance.ID] = cpu
	}
}
