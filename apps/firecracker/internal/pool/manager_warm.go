package pool

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rs/xid"

	"github.com/rshdhere/devin/apps/firecracker/internal/cnihelper"
	"github.com/rshdhere/devin/apps/firecracker/internal/vm"
)

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

		if m.networkBusy() {
			time.Sleep(time.Second)
			continue
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

		if m.networkBusy() {
			slog.Info("discarding warm microVM; network claimed by active VM",
				"runtime", runtime, "vmId", instance.ID)
			_ = instance.Shutdown(context.Background())
			time.Sleep(time.Second)
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

func (m *Manager) networkBusy() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.assigned) > 0 || len(m.vms) > 0
}

// reapUnhealthyWarmVMs periodically probes warm-pool guests and discards any
// that stop responding on the shared static IP. Without this, a dead warm VM
// can stay counted as ready until claim time (or forever if never claimed).
func (m *Manager) reapUnhealthyWarmVMs(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.reapWarmQueuesOnce()
		}
	}
}

func (m *Manager) reapWarmQueuesOnce() {
	m.mu.RLock()
	queues := make([]chan *vm.Instance, 0, len(m.ready))
	for _, queue := range m.ready {
		queues = append(queues, queue)
	}
	m.mu.RUnlock()

	for _, queue := range queues {
		kept := make([]*vm.Instance, 0, cap(queue))
		for _, warm := range drainQueue(queue) {
			checkCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			err := warm.HealthCheck(checkCtx)
			cancel()
			if err != nil {
				m.mu.Lock()
				if m.readyCount > 0 {
					m.readyCount--
				}
				m.mu.Unlock()
				slog.Warn("discarding unhealthy warm microVM",
					"vmId", warm.ID, "runtime", warm.Runtime, "error", err)
				_ = cnihelper.RepairGuestEgress(m.cfg.CNIConfDir, m.cfg.CNINetworkName)
				_ = warm.Shutdown(context.Background())
				continue
			}
			kept = append(kept, warm)
		}
		for _, warm := range kept {
			select {
			case queue <- warm:
			default:
				m.mu.Lock()
				if m.readyCount > 0 {
					m.readyCount--
				}
				m.mu.Unlock()
				_ = warm.Shutdown(context.Background())
			}
		}
	}
}

func (m *Manager) drainWarmPool() {
	m.mu.RLock()
	queues := make([]chan *vm.Instance, 0, len(m.ready))
	for _, queue := range m.ready {
		queues = append(queues, queue)
	}
	m.mu.RUnlock()

	drained := make([]*vm.Instance, 0)
	for _, queue := range queues {
		for _, warm := range drainQueue(queue) {
			m.mu.Lock()
			if m.readyCount > 0 {
				m.readyCount--
			}
			m.mu.Unlock()
			drained = append(drained, warm)
		}
	}

	for _, warm := range drained {
		slog.Info("draining warm microVM for exclusive CNI lease",
			"vmId", warm.ID, "runtime", warm.Runtime)
		if err := warm.Shutdown(context.Background()); err != nil {
			slog.Warn("failed to shut down warm microVM during drain",
				"vmId", warm.ID, "error", err)
		}
	}
}

func drainQueue(queue chan *vm.Instance) []*vm.Instance {
	out := make([]*vm.Instance, 0)
	for {
		select {
		case warm := <-queue:
			out = append(out, warm)
		default:
			return out
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
