# Runtime images

Runtime images become **Firecracker golden snapshots**. Each directory builds a Docker image that is exported to `rootfs.ext4`, booted once, snapshotted, and restored in ~300ms by `firecracker`.

The scheduler picks a **runtime** snapshot from the user prompt (Template agent) or always **`agent`** for Cursor/Claude:

| Prompt signals | Snapshot |
| --- | --- |
| next.js, nextjs, turbopack | `nextjs` |
| node, express, todo-app, npm | `node` |
| go, golang, gin | `go` |
| rust, cargo | `rust` |
| python, django, fastapi | `python` |
| Cursor / Claude agent | `agent` (always) |

Build every image from the **repository root**.

## Prerequisites

Compile the supervisor binary once:

```sh
go build -o apps/runtime/bin/runtime ./apps/runtime/cmd/runtime
```

Download a Firecracker-compatible kernel (once per host):

```sh
mkdir -p /var/lib/devin/linux
curl -fsSL -o /var/lib/devin/linux/vmlinux \
  https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux
```

## Variants

| Directory | Image tag | Stack |
| --- | --- | --- |
| `nextjs/` | `devin-runtime-nextjs:latest` | Node 22, Bun, Git — Next.js apps |
| `agent/` | `devin-runtime-agent:latest` | Cursor CLI + Claude Code + supervisor |
| `go/` | `devin-runtime-go:latest` | Go 1.23, Git |
| `rust/` | `devin-runtime-rust:latest` | Rust 1.83, OpenSSL/pkg-config |
| `node/` | `devin-runtime-node:latest` | Node 22 |
| `python/` | `devin-runtime-python:latest` | Python 3.12 |

## Build Docker images

```sh
docker build -f runtime/agent/Dockerfile -t devin-runtime-agent:latest .
docker build -f runtime/nextjs/Dockerfile -t devin-runtime-nextjs:latest .
docker build -f runtime/go/Dockerfile -t devin-runtime-go:latest .
docker build -f runtime/rust/Dockerfile -t devin-runtime-rust:latest .
docker build -f runtime/node/Dockerfile -t devin-runtime-node:latest .
docker build -f runtime/python/Dockerfile -t devin-runtime-python:latest .
```

## Build Firecracker snapshots

On a Linux host with `firecracker`, CNI plugins, and root:

```sh
chmod +x scripts/build-firecracker-rootfs.sh scripts/build-firecracker-snapshot.sh

# 1. Export Docker rootfs to ext4
sudo ./scripts/build-firecracker-rootfs.sh nextjs devin-runtime-nextjs:latest

# 2. Boot once and capture golden snapshot
sudo ./scripts/build-firecracker-snapshot.sh nextjs
```

Snapshot layout:

```
/var/lib/devin/snapshots/nextjs/
  rootfs.ext4
  mem.snap
  vm.snap
  meta.json
```

## Kubernetes

Sandboxes reference a **runtime** (not a Pod image):

```yaml
spec:
  runtime: nextjs
  cpu: 2
  memory: 4Gi
```

The orchestrator selects a `FirecrackerHost`, and `firecracker` restores the matching snapshot. The runtime supervisor listens on port **8081** inside the microVM.

Greenfield template tasks use the **`nextjs`** snapshot only (no `agent` snapshot rebuild required). Rebuild `nextjs` after changing `runtime/nextjs/` or shared supervisor code under `apps/runtime/`.

## Task workspace

Agent and git operations use **`/workspace`**, backed by a **tmpfs** mount created at supervisor startup. Firecracker restores the root drive read-only, so the writable tmpfs layer must be present in the golden snapshot memory image.

After changing `apps/runtime/` or `runtime/*`, rebuild rootfs and snapshots on each execution host (see `deployment.md` § snapshot rebuild).
