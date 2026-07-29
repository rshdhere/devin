package operator

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"

	"github.com/rshdhere/devin/infra/internal/envx"
	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func PatchSchedulerURL(ctx context.Context) error {
	url := os.Getenv("SCHEDULER_URL")
	if url == "" {
		return errors.New("SCHEDULER_URL is required")
	}
	for _, ns := range strings.Fields(envx.Env("NAMESPACES", "devin-app devin-staging")) {
		if err := exec.CommandContext(ctx, "kubectl", "get", "namespace", ns).Run(); err != nil {
			log.Printf("skipping missing namespace: %s", ns)
			continue
		}
		if exec.CommandContext(ctx, "kubectl", "get", "secret", "devin-server", "-n", ns).Run() == nil {
			_ = sysutil.Command(ctx, "kubectl", "patch", "secret", "devin-server", "-n", ns, "--type", "merge", "-p", fmt.Sprintf(`{"stringData":{"SCHEDULER_URL":%q}}`, url))
		}
		for _, deploy := range []string{"devin-server", "server"} {
			if exec.CommandContext(ctx, "kubectl", "get", "deployment", deploy, "-n", ns).Run() == nil {
				if err := sysutil.Command(ctx, "kubectl", "set", "env", "deployment/"+deploy, "-n", ns, "SCHEDULER_URL="+url); err != nil {
					return err
				}
				if err := sysutil.Command(ctx, "kubectl", "rollout", "restart", "deployment/"+deploy, "-n", ns); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
