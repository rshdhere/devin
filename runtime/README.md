# Runtime images

Runtime images become **Firecracker golden snapshots**. Each directory builds a Docker image that is exported to `rootfs.ext4`, booted once, snapshotted, and restored in ~300ms by `firecracker`.

The scheduler picks a **runtime** snapshot from the user prompt for every agent:

| Prompt signals               | Snapshot                    |
| ---------------------------- | --------------------------- |
| next.js, nextjs, turbopack   | `nextjs`                    |
| node, express, todo-app, npm | `node`                      |
| go, golang, gin              | `go`                        |
| rust, cargo                  | `rust`                      |
| python, django, fastapi      | `python`                    |
| Cursor / Claude agent        | The prompt's stack snapshot |

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

| Directory | Image tag                     | Stack                                                     |
| --------- | ----------------------------- | --------------------------------------------------------- |
| `nextjs/` | `devin-runtime-nextjs:latest` | Node 22, Bun, Git, Cursor/Claude, Rust/GCC — Next.js apps |
| `agent/`  | `devin-runtime-agent:latest`  | Cursor CLI + Claude Code + Rust/GCC + supervisor          |
| `go/`     | `devin-runtime-go:latest`     | Go 1.23, Cursor/Claude, Rust/GCC                          |
| `rust/`   | `devin-runtime-rust:latest`   | Rust 1.83, Cursor/Claude, OpenSSL/pkg-config, GCC         |
| `node/`   | `devin-runtime-node:latest`   | Node 22, Cursor/Claude, Rust/GCC                          |
| `python/` | `devin-runtime-python:latest` | Python 3.12, Cursor/Claude, Rust/GCC                      |

Every runtime image installs **Rust/Cargo + GCC/build-essential** via `runtime/scripts/install-build-toolchain.sh`. The toolchain lives under `/usr/local/rustup` and `/usr/local/cargo` on the read-only rootfs. Writable caches use:

```text
HOME=/workspace/.home
CARGO_HOME=/workspace/.build/cargo-home
CARGO_TARGET_DIR=/workspace/.build/target
RUSTUP_HOME=/usr/local/rustup
```

Workspace tmpfs defaults to **12G** (`WORKSPACE_TMPFS_SIZE`); rootfs export defaults to **8Gi** (`ROOTFS_SIZE_MB=8192`).

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
  memory: 8Gi
```

The orchestrator selects a `FirecrackerHost`, and `firecracker` restores the matching snapshot. Guest RAM/vCPU are fixed by the golden snapshot (`FIRECRACKER_SNAPSHOT_MEM_MIB=8192`, `FIRECRACKER_SNAPSHOT_VCPU=2` by default) — Firecracker cannot resize memory on restore, so scheduler `memory`/`cpu` must match the snapshot. The runtime supervisor listens on port **8081** inside the microVM.

Every stack snapshot contains the agent CLIs, so Cursor/Claude can use the compiler and package manager matching the prompt. Rebuild the selected stack snapshot after changing its Dockerfile or shared supervisor code under `apps/runtime/`.

## Task workspace

Agent and git operations use **`/workspace`**, backed by a **tmpfs** mount created at supervisor startup. Firecracker restores the root drive read-only, so the writable tmpfs layer must be present in the golden snapshot memory image.

After changing `apps/runtime/` or `runtime/*`, rebuild rootfs and snapshots on each execution host (see `deployment.md` § snapshot rebuild).
