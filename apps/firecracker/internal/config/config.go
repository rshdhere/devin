package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	HostName        string
	Port            int
	DryRun          bool
	RuntimeFallback string
	PoolSize        int
	DefaultRuntime  string

	KernelPath      string
	SnapshotDir     string
	VMMDir          string
	FirecrackerBin  string
	CNINetworkName  string
	CNIConfDir      string
	CNIBinPath      string
	RuntimePort     int
	WarmVCPU        int32
	WarmMemoryMiB   int64
	CapacityCPU     int32
	CapacityMemory  string
}

func LoadFromEnv() Config {
	return Config{
		HostName:        envString("FIRECRACKER_HOST_NAME", "fc-local"),
		Port:            envInt("FIRECRACKER_HOST_PORT", 9092),
		DryRun:          envBool("FIRECRACKER_DRY_RUN", true),
		RuntimeFallback: envString("RUNTIME_URL", "http://localhost:8081"),
		// Golden snapshots embed a fixed guest IP; only one warmed VM can bind it.
		PoolSize: envInt("FIRECRACKER_POOL_SIZE", 1),
		DefaultRuntime:  envString("FIRECRACKER_DEFAULT_RUNTIME", "nextjs"),
		KernelPath:      envString("FIRECRACKER_KERNEL_PATH", "/var/lib/devin/linux/vmlinux"),
		SnapshotDir:     envString("FIRECRACKER_SNAPSHOT_DIR", "/var/lib/devin/snapshots"),
		VMMDir:          envString("FIRECRACKER_VMM_DIR", "/var/lib/devin/vms"),
		FirecrackerBin:  envString("FIRECRACKER_BIN", "/usr/bin/firecracker"),
		CNINetworkName:  envString("FIRECRACKER_CNI_NETWORK", "fcnet"),
		CNIConfDir:      envString("FIRECRACKER_CNI_CONF_DIR", "/etc/cni/conf.d"),
		CNIBinPath:      envString("FIRECRACKER_CNI_BIN_PATH", "/opt/cni/bin"),
		RuntimePort:     envInt("FIRECRACKER_RUNTIME_PORT", 8081),
		WarmVCPU:        int32(envInt("FIRECRACKER_WARM_VCPU", 1)),
		WarmMemoryMiB:   int64(envInt("FIRECRACKER_WARM_MEMORY_MIB", 512)),
		CapacityCPU:     int32(envInt("FIRECRACKER_CAPACITY_CPU", 32)),
		CapacityMemory:  envString("FIRECRACKER_CAPACITY_MEMORY", "64Gi"),
	}
}

func (c Config) ValidateProduction() error {
	if c.DryRun {
		return nil
	}
	if c.KernelPath == "" {
		return fmt.Errorf("FIRECRACKER_KERNEL_PATH is required")
	}
	if c.SnapshotDir == "" {
		return fmt.Errorf("FIRECRACKER_SNAPSHOT_DIR is required")
	}
	if c.FirecrackerBin == "" {
		return fmt.Errorf("FIRECRACKER_BIN is required")
	}
	return nil
}

func ParseMemoryMiB(raw string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 512, nil
	}

	lower := strings.ToLower(raw)
	switch {
	case strings.HasSuffix(lower, "gi"):
		value, err := strconv.ParseInt(strings.TrimSuffix(lower, "gi"), 10, 64)
		if err != nil {
			return 0, err
		}
		return value * 1024, nil
	case strings.HasSuffix(lower, "mi"):
		return strconv.ParseInt(strings.TrimSuffix(lower, "mi"), 10, 64)
	default:
		value, err := strconv.ParseInt(lower, 10, 64)
		if err != nil {
			return 0, err
		}
		return value, nil
	}
}

func envString(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	return raw == "true" || raw == "1"
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}
