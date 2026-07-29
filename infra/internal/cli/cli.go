package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/rshdhere/devin/infra/internal/host"
	"github.com/rshdhere/devin/infra/internal/operator"
)

func Run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return usage()
	}
	switch args[0] {
	case "deploy-images":
		return operator.DeployImages(ctx, args[1:])
	case "bootstrap-snapshots":
		return operator.Bootstrap(ctx, args[1:], false)
	case "rebuild-agent-snapshot":
		return operator.Bootstrap(ctx, args[1:], true)
	case "sync-host-config":
		return operator.SyncHost(ctx, args[1:])
	case "enable-nested-virt":
		return operator.NestedVirt(ctx, args[1:])
	case "patch-scheduler-url":
		return operator.PatchSchedulerURL(ctx)
	case "set-platform-secret":
		return operator.SetSecret(ctx, args[1:])
	case "configure-profile":
		return operator.ConfigureProfile(ctx)
	case "install-ssm-plugin":
		return operator.InstallPlugin(ctx)
	case "rebootstrap":
		return operator.Rebootstrap(ctx, args[1:])
	case "sync-platform-config":
		return host.SyncPlatformConfig(ctx)
	case "fix-sandbox-dns":
		return host.FixSandboxDNS(ctx)
	case "fix-cni":
		return host.FixCNI(ctx)
	case "bootstrap-snapshots-local":
		return host.BootstrapSnapshotsLocal(ctx)
	case "host-deploy":
		return host.Deploy(ctx)
	case "install-self":
		return host.InstallSelf()
	case "help", "-h", "--help":
		return usage()
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func usage() error {
	fmt.Fprintln(os.Stderr, `Usage: devin-infra <command>
Operator commands: deploy-images, bootstrap-snapshots, rebuild-agent-snapshot,
sync-host-config, enable-nested-virt, patch-scheduler-url, set-platform-secret,
configure-profile, install-ssm-plugin, rebootstrap
Host commands: sync-platform-config, fix-sandbox-dns, fix-cni,
bootstrap-snapshots-local, host-deploy, install-self`)
	return nil
}
