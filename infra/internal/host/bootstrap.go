package host

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rshdhere/devin/infra/internal/envx"
	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func BootstrapSnapshotsLocal(ctx context.Context) error {
	if err := sysutil.MustRoot(); err != nil {
		return err
	}
	force := envx.Env("DEVIN_FORCE_SNAPSHOT_REBUILD", "false") == "true"
	writeMarker := false
	// Bump this marker when runtime image contents or snapshot selection
	// semantics change. Existing hosts must rebuild their golden snapshots
	// before prompt-selected stack runtimes are served. v3 includes the
	// shared Git/toolchain and agent CLI changes used by stack runtimes.
	marker := "/var/lib/devin/.snapshots-bootstrapped-v3"
	if !force {
		if _, err := os.Stat(marker); err == nil {
			log.Printf("snapshots already bootstrapped (%s)", marker)
			_ = sysutil.Systemctl(ctx, "enable", "--now", "devin-firecracker.service")
			_ = sysutil.Systemctl(ctx, "enable", "--now", "devin-scheduler.service")
			return nil
		}
		// A missing versioned marker means existing snapshot metadata may
		// describe an older image. Rebuild instead of trusting those entries.
		force = true
		writeMarker = true
	}
	if err := requireKVM(ctx); err != nil {
		return err
	}
	for _, cmd := range [][]string{
		{"apt-get", "update", "-y"},
		{"apt-get", "install", "-y", "curl", "ca-certificates", "git", "golang-go", "e2fsprogs", "build-essential", "jq"},
	} {
		if err := sysutil.Command(ctx, cmd[0], cmd[1:]...); err != nil {
			return err
		}
	}
	if err := installFirecracker(ctx); err != nil {
		return err
	}
	if err := installCNI(ctx); err != nil {
		return err
	}
	if err := installKernel(ctx); err != nil {
		return err
	}
	_ = os.MkdirAll("/var/lib/devin/snapshots", 0755)
	_ = os.MkdirAll("/var/lib/devin/vms", 0755)
	build := envx.Env("DEVIN_BUILD_DIR", "/opt/devin-build")
	repo, ref := envx.Env("DEVIN_REPO_URL", "https://github.com/rshdhere/devin.git"), envx.Env("DEVIN_REPO_REF", "main")
	if err := cloneRepo(ctx, build, repo, ref, force); err != nil {
		return err
	}
	for _, rt := range strings.Fields(envx.Env("DEVIN_RUNTIMES", "nextjs agent node go rust python")) {
		meta := filepath.Join("/var/lib/devin/snapshots", rt, "meta.json")
		if !force {
			if _, e := os.Stat(meta); e == nil {
				log.Printf("snapshot already exists for %s", rt)
				continue
			}
		}
		if err := buildRuntime(ctx, build, rt, force); err != nil {
			return err
		}
	}
	if writeMarker {
		_ = os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0644)
	}
	_ = SyncPlatformConfig(ctx)
	if force {
		_ = sysutil.Systemctl(ctx, "restart", "devin-firecracker.service")
		_ = sysutil.Systemctl(ctx, "restart", "devin-firecracker-host.service")
	} else {
		_ = sysutil.Systemctl(ctx, "enable", "--now", "devin-firecracker.service")
		_ = sysutil.Systemctl(ctx, "enable", "--now", "devin-firecracker-host.service")
	}
	_ = sysutil.Systemctl(ctx, "enable", "--now", "devin-scheduler.service")
	time.Sleep(3 * time.Second)
	_ = sysutil.Command(ctx, "curl", "-sf", "http://127.0.0.1:9092/health")
	_ = sysutil.Command(ctx, "curl", "-sf", "http://127.0.0.1:9092/v1/status")
	_ = sysutil.Command(ctx, "curl", "-sf", "http://127.0.0.1:9091/health")
	return nil
}

func requireKVM(ctx context.Context) error {
	if st, err := os.Stat("/dev/kvm"); err == nil && st.IsDir() {
		log.Print("repairing /dev/kvm (docker created a directory bind mount)")
		_ = sysutil.Systemctl(ctx, "stop", "devin-firecracker.service", "devin-firecracker-host.service")
		_ = sysutil.Command(ctx, "docker", "stop", "firecracker", "firecracker-host")
		_ = os.RemoveAll("/dev/kvm")
	}
	_ = sysutil.Command(ctx, "modprobe", "kvm")
	_ = sysutil.Command(ctx, "modprobe", "kvm_intel")
	_ = sysutil.Command(ctx, "modprobe", "kvm_amd")
	st, err := os.Stat("/dev/kvm")
	if err != nil || st.IsDir() {
		return errors.New("/dev/kvm is not available; enable nested virtualization first")
	}
	return nil
}

func installFirecracker(ctx context.Context) error {
	if _, err := os.Stat("/usr/local/bin/firecracker"); err == nil {
		return nil
	}
	version := envx.Env("FIRECRACKER_VERSION", "1.8.0")
	url := fmt.Sprintf("https://github.com/firecracker-microvm/firecracker/releases/download/v%s/firecracker-v%s-x86_64.tgz", version, version)
	archive := "/tmp/firecracker.tgz"
	if err := sysutil.Download(ctx, url, archive); err != nil {
		return err
	}
	if err := sysutil.Command(ctx, "tar", "-xzf", archive, "-C", "/tmp"); err != nil {
		return err
	}
	src := fmt.Sprintf("/tmp/release-v%s-x86_64/firecracker-v%s-x86_64", version, version)
	return sysutil.Command(ctx, "install", "-m", "755", src, "/usr/local/bin/firecracker")
}

func installCNI(ctx context.Context) error {
	_ = os.MkdirAll("/etc/cni/conf.d", 0755)
	_ = os.MkdirAll("/opt/cni/bin", 0755)
	if _, err := os.Stat("/etc/cni/resolv.conf"); err != nil {
		if err := sysutil.WriteFile("/etc/cni/resolv.conf", "nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 8.8.4.4\n", 0644); err != nil {
			return err
		}
	}
	needCNI := false
	if raw, err := os.ReadFile("/etc/cni/conf.d/fcnet.conflist"); err != nil || strings.Contains(string(raw), `"host-local"`) {
		needCNI = true
	}
	if needCNI {
		if err := sysutil.WriteFile("/etc/cni/conf.d/fcnet.conflist", fcnet+"\n", 0644); err != nil {
			return err
		}
		_ = os.RemoveAll("/var/lib/cni/networks/fcnet")
	}
	if _, err := os.Stat("/opt/cni/bin/tc-redirect-tap"); err != nil {
		registry, tag := envx.Env("DEVIN_CONTAINER_REGISTRY", "docker.io/rshdhere"), envx.Env("DEVIN_CONTAINER_IMAGE_TAG", envx.Env("DEVIN_IMAGE_TAG", "latest"))
		image := registry + "/devin-firecracker:" + tag
		_ = sysutil.Command(ctx, "docker", "rm", "-f", "devin-cni-extract")
		if err := sysutil.Command(ctx, "docker", "create", "--name", "devin-cni-extract", image); err != nil {
			return err
		}
		cpErr := sysutil.Command(ctx, "docker", "cp", "devin-cni-extract:/opt/cni/bin/.", "/opt/cni/bin/")
		_ = sysutil.Command(ctx, "docker", "rm", "-f", "devin-cni-extract")
		if cpErr != nil {
			return cpErr
		}
		_ = sysutil.Command(ctx, "bash", "-c", "chmod 755 /opt/cni/bin/*")
	}
	return nil
}

func installKernel(ctx context.Context) error {
	path := "/var/lib/devin/linux/vmlinux"
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	_ = os.MkdirAll(filepath.Dir(path), 0755)
	return sysutil.Download(ctx, "https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin", path)
}

func cloneRepo(ctx context.Context, build, repo, ref string, force bool) error {
	if _, err := os.Stat(filepath.Join(build, ".git")); err == nil {
		if err := sysutil.Command(ctx, "git", "-C", build, "fetch", "--depth", "1", "origin", ref); err != nil {
			return err
		}
		if force {
			if err := sysutil.Command(ctx, "git", "-C", build, "reset", "--hard", "origin/"+ref); err != nil {
				return err
			}
			return sysutil.Command(ctx, "git", "-C", build, "clean", "-fdx", "-e", ".gocache", "-e", ".gomodcache")
		}
		_ = sysutil.Command(ctx, "git", "-C", build, "checkout", ref)
		_ = sysutil.Command(ctx, "git", "-C", build, "pull", "--ff-only", "origin", ref)
		return nil
	}
	_ = os.RemoveAll(build)
	return sysutil.Command(ctx, "git", "clone", "--depth", "1", "--branch", ref, repo, build)
}

func buildRuntime(ctx context.Context, build, runtime string, force bool) error {
	if force {
		_ = sysutil.Command(ctx, "sed", "-i", "s/docker build /docker build --no-cache /", filepath.Join(build, "scripts/build-firecracker-rootfs.sh"))
	}
	_ = sysutil.Command(ctx, "bash", "-c", fmt.Sprintf(`
for df in %q/runtime/*/Dockerfile; do
  [ -f "$df" ] || continue
  grep -q ' unzip ' "$df" || sed -i 's/openssh-client \\$/openssh-client unzip \\/' "$df"
done
`, build))
	if err := sysutil.RunDir(ctx, filepath.Join(build, "apps/firecracker"), "go", "build", "-o", "/usr/local/bin/snapshot-cni", "./cmd/snapshot-cni"); err != nil {
		return err
	}
	if err := sysutil.RunDir(ctx, build, "./scripts/build-firecracker-rootfs.sh", runtime); err != nil {
		return err
	}
	return sysutil.RunDir(ctx, build, "./scripts/build-firecracker-snapshot.sh", runtime)
}
