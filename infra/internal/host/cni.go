package host

import (
	"context"
	"os"

	"github.com/rshdhere/devin/infra/internal/envx"
	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func FixCNI(ctx context.Context) error {
	if err := sysutil.MustRoot(); err != nil {
		return err
	}
	_ = sysutil.Systemctl(ctx, "stop", "devin-firecracker-host.service", "devin-firecracker.service", "devin-scheduler.service")
	_ = sysutil.Command(ctx, "docker", "stop", "firecracker-host", "firecracker", "scheduler")
	_ = sysutil.Command(ctx, "bash", "-c", `
while read -r line; do
  rule="${line/-A/-D}"
  iptables -t nat $rule 2>/dev/null || true
done < <(iptables -t nat -S POSTROUTING | grep fcnet || true)
while read -r chain; do
  [[ -n "$chain" ]] || continue
  iptables -t nat -F "$chain" 2>/dev/null || true
  iptables -t nat -X "$chain" 2>/dev/null || true
done < <(iptables -t nat -S | awk '/^-N CNI-/{print $2}')
`)
	if err := FixSandboxDNS(ctx); err != nil {
		return err
	}
	_ = os.RemoveAll("/var/lib/cni/networks/fcnet")
	_ = os.Rename("/var/lib/devin/snapshots/.agent-offline", "/var/lib/devin/snapshots/agent")
	build := envx.Env("DEVIN_BUILD_DIR", "/opt/devin-build")
	registry, tag := envx.Env("DEVIN_CONTAINER_REGISTRY", "docker.io/rshdhere"), envx.Env("DEVIN_IMAGE_TAG", "cni-fix")
	if _, err := os.Stat(build); err == nil {
		_ = sysutil.Command(ctx, "git", "-C", build, "fetch", "--depth", "1", "origin", "main")
		_ = sysutil.Command(ctx, "git", "-C", build, "reset", "--hard", "origin/main")
		_ = sysutil.RunDir(ctx, build, "docker", "build", "-f", "apps/firecracker/Dockerfile", "-t", registry+"/devin-firecracker:"+tag, ".")
		os.Setenv("DEVIN_IMAGE_TAG", tag)
	}
	return Deploy(ctx)
}
