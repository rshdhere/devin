package reconcile

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"github.com/rshdhere/devin/packages/orchestrator/config"
	"github.com/rshdhere/devin/packages/orchestrator/store"
)

type externalHostSpec struct {
	Name             string `json:"name"`
	Address          string `json:"address"`
	SchedulerAddress string `json:"schedulerAddress"`
	CPU              int32  `json:"cpu"`
	Memory           string `json:"memory"`
}

func StartExternalHostBootstrap(ctx context.Context, hostStore store.HostStore, cfg config.Config) {
	if hostStore == nil {
		return
	}

	sync := func() {
		if err := EnsureExternalHosts(ctx, hostStore, cfg); err != nil {
			slog.Warn("failed to sync external firecracker hosts", "error", err)
		}
	}

	sync()

	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sync()
			}
		}
	}()
}

func EnsureExternalHosts(ctx context.Context, hostStore store.HostStore, cfg config.Config) error {
	hosts, err := loadExternalHosts(cfg)
	if err != nil {
		return err
	}

	for _, host := range hosts {
		if host.Name == "" || host.Address == "" {
			slog.Info("skipping invalid external firecracker host", "name", host.Name, "address", host.Address)
			continue
		}
		cpu := host.CPU
		if cpu <= 0 {
			cpu = cfg.DefaultHostCPU
		}
		memory := strings.TrimSpace(host.Memory)
		if memory == "" {
			memory = cfg.DefaultHostMemory
		}

		hostCR := &devinv1.FirecrackerHost{
			ObjectMeta: metav1.ObjectMeta{
				Name: host.Name,
				Labels: map[string]string{
					"devin.baby/managed-by": "orchestrator-external",
				},
			},
			Spec: devinv1.FirecrackerHostSpec{
				Address:          host.Address,
				SchedulerAddress: host.SchedulerAddress,
				Capacity: devinv1.HostCapacity{
					CPU:    cpu,
					Memory: memory,
				},
			},
		}
		if err := hostStore.Upsert(ctx, hostCR); err != nil {
			slog.Error("failed to upsert external firecracker host", "name", host.Name, "error", err)
			continue
		}
		slog.Info("ensured external firecracker host", "name", host.Name, "address", host.Address)
	}

	return nil
}

func loadExternalHosts(cfg config.Config) ([]externalHostSpec, error) {
	raw := strings.TrimSpace(cfg.ExternalHostsJSON)
	if raw == "" && cfg.ExternalHostsFile != "" {
		data, err := os.ReadFile(cfg.ExternalHostsFile)
		if err != nil {
			if os.IsNotExist(err) {
				return nil, nil
			}
			return nil, err
		}
		raw = strings.TrimSpace(string(data))
	}
	if raw == "" {
		return nil, nil
	}

	var hosts []externalHostSpec
	if err := json.Unmarshal([]byte(raw), &hosts); err != nil {
		return nil, err
	}
	return hosts, nil
}
