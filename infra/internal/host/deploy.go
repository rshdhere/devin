package host

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/rshdhere/devin/infra/internal/envx"
	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func Deploy(ctx context.Context) error {
	if err := sysutil.MustRoot(); err != nil {
		return err
	}
	if err := FixSandboxDNS(ctx); err != nil {
		log.Printf("fix-sandbox-dns during deploy: %v", err)
	}
	registry, tag := envx.Env("DEVIN_CONTAINER_REGISTRY", "docker.io/rshdhere"), envx.Env("DEVIN_IMAGE_TAG", "latest")
	hostName := envx.Env("DEVIN_HOST_NAME", "")
	if hostName == "" {
		if b, e := os.ReadFile("/etc/devin/host-name"); e == nil {
			hostName = strings.TrimSpace(string(b))
		}
	}
	if hostName == "" {
		hostName = "devin-production-fc-01"
	}
	for _, image := range []string{registry + "/devin-firecracker:" + tag, registry + "/devin-scheduler:" + tag} {
		if err := sysutil.Command(ctx, "docker", "pull", image); err != nil {
			return err
		}
	}
	_ = os.RemoveAll("/var/lib/cni/networks/fcnet")
	if entries, err := os.ReadDir("/var/run/netns"); err == nil {
		for _, e := range entries {
			_ = sysutil.Command(ctx, "ip", "netns", "del", e.Name())
			_ = os.RemoveAll(filepath.Join("/var/lib/cni", e.Name()))
		}
	}
	if raw, err := os.ReadFile("/etc/cni/conf.d/fcnet.conflist"); err == nil && strings.Contains(string(raw), `"host-local"`) {
		_ = sysutil.WriteFile("/etc/cni/conf.d/fcnet.conflist", fcnet+"\n", 0644)
	}
	fc := fmt.Sprintf(`[Unit]
Description=devin.baby firecracker
After=docker.service
Requires=docker.service
[Service]
Restart=always
RestartSec=5
ExecStartPre=/bin/rm -rf /var/lib/cni/networks/fcnet
ExecStartPre=-/usr/bin/docker rm -f firecracker
ExecStart=/usr/bin/docker run --rm --name firecracker --privileged --network host -v /dev/kvm:/dev/kvm -v /var/lib/devin:/var/lib/devin -e FIRECRACKER_DRY_RUN=false -e FIRECRACKER_HOST_PORT=9092 -e FIRECRACKER_HOST_NAME=%s -e FIRECRACKER_POOL_SIZE=1 -e FIRECRACKER_DEFAULT_RUNTIME=agent -e FIRECRACKER_SNAPSHOT_DIR=/var/lib/devin/snapshots -e FIRECRACKER_KERNEL_PATH=/var/lib/devin/linux/vmlinux -e FIRECRACKER_VMM_DIR=/var/lib/devin/vms -e FIRECRACKER_RUNTIME_PORT=8081 -e FIRECRACKER_WARM_VCPU=2 -e FIRECRACKER_WARM_MEMORY_MIB=8192 -e FIRECRACKER_CNI_NETWORK=fcnet -e FIRECRACKER_CNI_CONF_DIR=/etc/cni/conf.d -e FIRECRACKER_CNI_BIN_PATH=/opt/cni/bin %s
ExecStop=/usr/bin/docker stop firecracker
[Install]
WantedBy=multi-user.target
`, hostName, registry+"/devin-firecracker:"+tag)
	scheduler := fmt.Sprintf(`[Unit]
Description=devin.baby scheduler
After=devin-firecracker.service
Wants=devin-firecracker.service
[Service]
Restart=always
RestartSec=5
Environment=ORCHESTRATOR_URL=http://pending-ssm-sync:9090
EnvironmentFile=-/etc/devin/scheduler-secrets.env
ExecStartPre=-/usr/bin/docker rm -f scheduler
ExecStart=/usr/bin/docker run --rm --name scheduler --network host --env-file /etc/devin/scheduler-secrets.env -v /var/lib/devin/task-snapshots:/var/lib/devin/task-snapshots -e DEVIN_SNAPSHOT_DIR=/var/lib/devin/task-snapshots -e DEVIN_SNAPSHOT_S3_BUCKET=${DEVIN_SNAPSHOT_S3_BUCKET} -e DEVIN_SNAPSHOT_S3_PREFIX=${DEVIN_SNAPSHOT_S3_PREFIX} -e SCHEDULER_PORT=9091 -e ORCHESTRATOR_URL=${ORCHESTRATOR_URL} -e FIRECRACKER_HOST_URL=http://127.0.0.1:9092 -e SCHEDULER_HOST_NAME=%s -e FIRECRACKER_HOST_NAME=%s -e QUEUE_DRIVER=${QUEUE_DRIVER} -e SQS_QUEUE_URL=${SQS_QUEUE_URL} -e AWS_REGION=%s -e DEFAULT_AGENT=cursor -e SANDBOX_READY_TIMEOUT_SECONDS=300 -e RUNTIME_READY_TIMEOUT_SECONDS=120 -e AGENT_RUN_TIMEOUT_MIN=60 %s
ExecStop=/usr/bin/docker stop scheduler
[Install]
WantedBy=multi-user.target
`, hostName, hostName, envx.Region(""), registry+"/devin-scheduler:"+tag)
	if err := sysutil.WriteFile("/etc/systemd/system/devin-firecracker.service", fc, 0644); err != nil {
		return err
	}
	if err := ensureTaskSnapshotDir(); err != nil {
		return err
	}
	if err := sysutil.WriteFile("/etc/systemd/system/devin-scheduler.service", scheduler, 0644); err != nil {
		return err
	}
	if err := sysutil.WriteFile("/etc/devin/host-name", hostName+"\n", 0644); err != nil {
		return err
	}
	ensureExecutionHostIP()
	_ = sysutil.Systemctl(ctx, "daemon-reload")
	_ = sysutil.Systemctl(ctx, "disable", "--now", "devin-firecracker-host.service")
	// Stop first and force-remove leftover containers. A previous failed restart
	// can leave "scheduler"/"firecracker" names claimed so `docker run --name`
	// fails with Conflict and systemd flaps forever.
	_ = sysutil.Systemctl(ctx, "stop", "devin-scheduler.service")
	_ = sysutil.Systemctl(ctx, "stop", "devin-firecracker.service")
	_ = sysutil.Command(ctx, "docker", "rm", "-f", "scheduler", "firecracker", "firecracker-host")
	if err := sysutil.Systemctl(ctx, "start", "devin-firecracker.service"); err != nil {
		_ = sysutil.Command(ctx, "journalctl", "-u", "devin-firecracker.service", "-n", "30", "--no-pager")
		return err
	}
	sysutil.WaitHTTP(ctx, "http://127.0.0.1:9092/health", 60*time.Second)
	_ = SyncPlatformConfig(ctx)
	if err := sysutil.Systemctl(ctx, "start", "devin-scheduler.service"); err != nil {
		_ = sysutil.Command(ctx, "journalctl", "-u", "devin-scheduler.service", "-n", "30", "--no-pager")
		return err
	}
	if !sysutil.WaitHTTP(ctx, "http://127.0.0.1:9091/health", 90*time.Second) {
		_ = sysutil.Command(ctx, "journalctl", "-u", "devin-scheduler.service", "-n", "30", "--no-pager")
		_ = sysutil.Command(ctx, "docker", "ps", "-a", "--filter", "name=scheduler", "--no-trunc")
		return errors.New("scheduler health check failed")
	}
	log.Printf("Deployed tag %s successfully", tag)
	return nil
}

func ensureExecutionHostIP() {
	path := "/etc/devin/scheduler-secrets.env"
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	if strings.Contains(string(raw), "EXECUTION_HOST_PRIVATE_IP=") {
		return
	}
	ip := envx.Env("EXECUTION_HOST_PRIVATE_IP", "")
	if ip == "" {
		out, err := exec.Command("curl", "-sf", "--connect-timeout", "2", "http://169.254.169.254/latest/meta-data/local-ipv4").Output()
		if err == nil {
			ip = strings.TrimSpace(string(out))
		}
	}
	if ip == "" {
		out, err := exec.Command("hostname", "-I").Output()
		if err == nil {
			fields := strings.Fields(string(out))
			if len(fields) > 0 {
				ip = fields[0]
			}
		}
	}
	if ip == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintf(f, "EXECUTION_HOST_PRIVATE_IP=%s\n", ip)
}
