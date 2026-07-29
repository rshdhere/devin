# `@devin/firecracker`

Host daemon that boots and manages **Firecracker microVMs** — the execution side of Devin’s **Devbox**. The brain plans; this process runs isolated guest VMs from golden snapshots so agents can shell, edit, and build safely.

In Devin’s architecture, the Devbox is the secure environment where code runs while the brain stays in the cloud — see [Enterprise Deployment](https://docs.devin.ai/enterprise/deployment/overview) (Brain vs Devbox) and [VPC overview](https://docs.devin.ai/enterprise/vpc/overview) (DevBox components).

## Role

```text
Scheduler / orchestrator
        ↓ HTTP :9092
Firecracker host daemon (this app)
        ↓ KVM + CNI + snapshot resume
Warm-pooled microVMs (runtime agent on :8081)
```

- Maintains a warm pool of VMs resumed from snapshots (`agent`, `nextjs`, …)
- Exposes a small HTTP API for create / list / get / delete VMs
- Registers capacity via `FIRECRACKER_HOST_NAME` (must match the `FirecrackerHost` CR)
- Supports `FIRECRACKER_DRY_RUN=true` for local development without KVM

## Layout

```text
cmd/firecracker/     # HTTP daemon entrypoint
cmd/snapshot-cni/    # CNI helper used when building snapshots
internal/
  config/            # Env-based configuration
  pool/              # Warm pool manager
  vm/                # Firecracker lifecycle (create / start / stop)
  snapshot/          # Snapshot + rootfs metadata
  cnihelper/         # CNI / tap / netns setup
  server/            # HTTP handlers
config/cni/          # fcnet.conflist + resolv.conf
```

## API

| Method | Path            | Purpose                |
| ------ | --------------- | ---------------------- |
| `GET`  | `/health`       | Liveness + ready count |
| `GET`  | `/v1/pool`      | Ready VM count         |
| `GET`  | `/v1/status`    | Host / pool status     |
| `GET`  | `/v1/vms`       | List VMs               |
| `POST` | `/v1/vms`       | Create / claim a VM    |
| `GET`  | `/v1/vms/{id}`  | Get VM                 |
| `DELETE` | `/v1/vms/{id}` | Tear down a VM       |

Default listen port: **9092** (`FIRECRACKER_HOST_PORT`).

## Develop

Dry-run (no Firecracker binary / KVM required):

```bash
cp apps/firecracker/.env.sample apps/firecracker/.env
# FIRECRACKER_DRY_RUN=true by default
bun run --cwd apps/firecracker dev
```

Build and run the binary:

```bash
bun run --cwd apps/firecracker build
bun run --cwd apps/firecracker start
```

Production images ship Firecracker, CNI plugins, and `tc-redirect-tap` — see `apps/firecracker/Dockerfile`.

## Key env

| Variable | Purpose |
| -------- | ------- |
| `FIRECRACKER_HOST_PORT` | HTTP listen port (default `9092`) |
| `FIRECRACKER_HOST_NAME` | Host id; must match `FirecrackerHost` CR / `SCHEDULER_HOST_NAME` |
| `FIRECRACKER_DRY_RUN` | Skip real VMM; stub pool (`true` locally) |
| `RUNTIME_URL` | Fallback runtime URL in dry-run |
| `FIRECRACKER_BIN` | Path to `firecracker` binary |
| `FIRECRACKER_KERNEL_PATH` | Guest kernel (`vmlinux`) |
| `FIRECRACKER_SNAPSHOT_DIR` | Golden snapshots (`/var/lib/devin/snapshots`) |
| `FIRECRACKER_VMM_DIR` | Per-VM working dirs |
| `FIRECRACKER_POOL_SIZE` | Warm pool depth |
| `FIRECRACKER_DEFAULT_RUNTIME` | Default snapshot/runtime (`nextjs`) |
| `FIRECRACKER_RUNTIME_PORT` | Guest runtime port (default `8081`) |
| `FIRECRACKER_CNI_*` | CNI network name, conf dir, bin path |
| `FIRECRACKER_CAPACITY_*` / `FIRECRACKER_WARM_*` | Host capacity and warm VM sizing |

See `.env.sample` for a starter file. Concept mapping: [docs/devin-alignment.md](../../docs/devin-alignment.md). Host ops: [infra/README.md](../../infra/README.md).
