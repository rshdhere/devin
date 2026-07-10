package reconcile

import (
	"context"
	"fmt"
	"log/slog"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

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
			if host.Spec.Capacity.CPU-host.Status.UsedCPU < cpu {
				return nil, fmt.Errorf("preferred firecracker host %q lacks capacity for %d cpu", preferredHost, cpu)
			}
			return host, nil
		}
		if len(list.Items) == 1 {
			host := &list.Items[0]
			if host.Spec.Address == "" {
				return nil, fmt.Errorf("preferred firecracker host %q not found", preferredHost)
			}
			if host.Spec.Capacity.CPU-host.Status.UsedCPU < cpu {
				return nil, fmt.Errorf("preferred firecracker host %q not found", preferredHost)
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
		if host.Spec.Capacity.CPU-host.Status.UsedCPU < cpu {
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
