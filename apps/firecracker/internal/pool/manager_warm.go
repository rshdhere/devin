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

		if err := vm.GuardMinFreeDisk(m.cfg.VMMDir, m.cfg.MinFreeDiskGiB); err != nil {
			slog.Warn("skipping warm microVM; host disk guardrail", "runtime", runtime, "error", err)
			time.Sleep(15 * time.Second)
			continue
		}

		if m.cfg.MaxActiveVMs > 0 {
			m.mu.RLock()
			tracked := len(m.vms)
			ready := m.readyCount
			max := m.cfg.MaxActiveVMs
			m.mu.RUnlock()
			// Warm VMs consume rootfs clones; keep tracked+queued under the active cap.
			if tracked+ready >= max {
				time.Sleep(time.Second)
				continue
			}
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
