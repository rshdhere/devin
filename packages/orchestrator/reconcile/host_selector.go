package reconcile

import (
	"context"
	"fmt"
	"log/slog"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func hostCapacityCPU(host *devinv1.FirecrackerHost) int32 {
	if host.Status.CapacityCPU > 0 {
		return host.Status.CapacityCPU
	}
	return host.Spec.Capacity.CPU
}

func hostAvailableCPU(host *devinv1.FirecrackerHost) int32 {
	capacity := hostCapacityCPU(host)
	available := capacity - host.Status.UsedCPU
	if available < 0 {
		return 0
	}
	return available
}

func hostLacksCapacity(host *devinv1.FirecrackerHost, cpu int32) bool {
	return hostAvailableCPU(host) < cpu
}

func hostCapacityError(hostName string, host *devinv1.FirecrackerHost, cpu int32) error {
	capacity := hostCapacityCPU(host)
	available := hostAvailableCPU(host)
	message := fmt.Sprintf(
		"preferred firecracker host %q lacks capacity for %d cpu (capacity=%d used=%d available=%d activeVMs=%d)",
		hostName,
		cpu,
		capacity,
		host.Status.UsedCPU,
		available,
		host.Status.ActiveVMs,
	)
	if host.Status.ActiveVMs > 0 {
		message += "; end idle devbox sessions or wait for sandboxes to be reclaimed"
	}
	return fmt.Errorf("%s", message)
}

func selectFirecrackerHost(ctx context.Context, c client.Client, namespace string, cpu int32, preferredHost string) (*devinv1.FirecrackerHost, error) {
	list := &devinv1.FirecrackerHostList{}
	if err := c.List(ctx, list, client.InNamespace(namespace)); err != nil {
		return nil, err
	}

	if preferredHost != "" {
		for i := range list.Items {
			host := &list.Items[i]
			if host.Name != preferredHost && host.Spec.NodeName != preferredHost {
				continue
			}
			if host.Spec.Address == "" {
				return nil, fmt.Errorf("preferred firecracker host %q has no address", preferredHost)
			}
			if hostLacksCapacity(host, cpu) {
				return nil, hostCapacityError(preferredHost, host, cpu)
			}
			return host, nil
		}
		if len(list.Items) == 1 {
			host := &list.Items[0]
			if host.Spec.Address == "" {
				return nil, fmt.Errorf("preferred firecracker host %q not found", preferredHost)
			}
			if hostLacksCapacity(host, cpu) {
				return nil, hostCapacityError(preferredHost, host, cpu)
			}
			slog.Warn(
				"preferred firecracker host not found; using sole registered host",
				"preferredHost", preferredHost,
				"selectedHost", host.Name,
			)
			return host, nil
		}
		return nil, fmt.Errorf("preferred firecracker host %q not found", preferredHost)
	}

	var selected *devinv1.FirecrackerHost
	for i := range list.Items {
		host := &list.Items[i]
		if host.Spec.Address == "" {
			continue
		}
		if hostLacksCapacity(host, cpu) {
			continue
		}
		if selected == nil || host.Status.ReadyVMs > selected.Status.ReadyVMs {
			selected = host
		}
	}

	if selected == nil {
		return nil, fmt.Errorf("no firecracker host with capacity for %d cpu", cpu)
	}
	return selected, nil
}
