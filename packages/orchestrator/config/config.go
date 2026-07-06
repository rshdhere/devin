package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	DryRun               bool
	SandboxNamespace     string
	FirecrackerNamespace string
	AppNamespace         string
	DefaultRuntime       string
	FirecrackerHostURL   string
	RuntimeFallbackURL   string
	ControllerEnabled    bool
	NodeRegisterEnabled  bool
	FirecrackerNodeLabel string
	FirecrackerHostPort  int
	SchedulerPort        int
	DefaultHostCPU       int32
	DefaultHostMemory    string
	ExternalHostsJSON    string
	ExternalHostsFile    string
}

func LoadFromEnv() Config {
	return Config{
		DryRun:               envBool("ORCHESTRATOR_DRY_RUN", true),
		SandboxNamespace:     envString("SANDBOX_NAMESPACE", "devin-sandboxes"),
		FirecrackerNamespace: envString("FIRECRACKER_NAMESPACE", "devin-firecracker"),
		AppNamespace:         envString("APP_NAMESPACE", "devin-app"),
		DefaultRuntime:       envString("SANDBOX_DEFAULT_RUNTIME", "nextjs"),
		FirecrackerHostURL:   envString("FIRECRACKER_HOST_URL", "http://localhost:9092"),
		RuntimeFallbackURL:   envString("RUNTIME_URL", "http://localhost:8081"),
		ControllerEnabled:    envBool("ORCHESTRATOR_CONTROLLER_ENABLED", true),
		NodeRegisterEnabled:  envBool("ORCHESTRATOR_NODE_REGISTER_ENABLED", true),
		FirecrackerNodeLabel: envString("FIRECRACKER_NODE_LABEL", "devin.baby/firecracker-host"),
		FirecrackerHostPort:  envInt("FIRECRACKER_HOST_PORT", 9092),
		SchedulerPort:        envInt("SCHEDULER_PORT", 9091),
		DefaultHostCPU:       int32(envInt("FIRECRACKER_DEFAULT_HOST_CPU", 8)),
		DefaultHostMemory:    envString("FIRECRACKER_DEFAULT_HOST_MEMORY", "16Gi"),
		ExternalHostsJSON:    envString("ORCHESTRATOR_EXTERNAL_HOSTS", ""),
		ExternalHostsFile:    envString("ORCHESTRATOR_EXTERNAL_HOSTS_FILE", ""),
	}
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
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}
