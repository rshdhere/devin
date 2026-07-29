# `@devin/orchestrator-app`

Control-plane process that turns **Sandbox** / **FirecrackerHost** requests into real Devboxes. The scheduler POSTs sandbox specs here; controllers (or dry-run memory store) select a host and call the Firecracker daemon to boot, suspend, or wake a microVM.

Maps to Devin’s Devbox lifecycle — secure execution environments driven from the cloud control plane. See [Enterprise Deployment](https://docs.devin.ai/enterprise/deployment/overview) (Brain vs Devbox) and [VPC overview](https://docs.devin.ai/enterprise/vpc/overview).

Controller logic lives in [`packages/orchestrator`](../../packages/orchestrator/README.md); this app is the HTTP + controller-runtime binary.

## Role

```text
Brain / scheduler worker
        ↓ ORCHESTRATOR_URL (:9090)
Orchestrator (this app)
        ↓ Sandbox / FirecrackerMachine CRs  (or in-memory dry-run)
        ↓ HTTP to FirecrackerHost
Firecracker host daemon → microVM (runtime :8081)
```

- Internal REST API for sandboxes and FirecrackerHost registry
- Dry-run mode for local bring-up without a cluster
- Production mode: controller-runtime against Kubernetes CRDs
- Optional node-pool auto-registration or external EC2 host bootstrap (Path B)

## Layout

```text
cmd/orchestrator/     # Entrypoint (HTTP + optional controllers)
internal/server/      # Internal HTTP API handlers
```

Shared packages:

```text
packages/orchestrator/   # Config, store, reconcile controllers, host client
packages/sandbox/        # Sandbox / FirecrackerHost / Machine CRD types
```

## API

| Method   | Path                                           | Purpose              |
| -------- | ---------------------------------------------- | -------------------- |
| `GET`    | `/health`                                      | Liveness             |
| `GET`    | `/internal/v1/sandboxes`                       | List sandboxes       |
| `POST`   | `/internal/v1/sandboxes`                       | Create sandbox       |
| `GET`    | `/internal/v1/sandboxes/{name}`                | Get sandbox          |
| `DELETE` | `/internal/v1/sandboxes/{name}`                | Delete sandbox       |
| `POST`   | `/internal/v1/sandboxes/{name}/suspend`        | Suspend (idle sleep) |
| `POST`   | `/internal/v1/sandboxes/{name}/wake`           | Wake suspended VM    |
| `GET`    | `/internal/v1/firecracker-hosts`               | List hosts           |
| `GET`    | `/internal/v1/firecracker-hosts/{name}`        | Get host             |
| `PUT`    | `/internal/v1/firecracker-hosts/{name}`        | Upsert host          |

Default listen port: **9090** (`ORCHESTRATOR_PORT`).

## Develop

Dry-run (no kubeconfig / cluster required):

```bash
cp apps/orchestrator/.env.sample apps/orchestrator/.env
# ORCHESTRATOR_DRY_RUN=true by default
bun run --cwd apps/orchestrator dev
```

Build and run the binary:

```bash
bun run --cwd apps/orchestrator build
bun run --cwd apps/orchestrator start
```

Point `ORCHESTRATOR_URL` on brain / scheduler at `http://localhost:9090`.

## Key env

| Variable | Purpose |
| -------- | ------- |
| `ORCHESTRATOR_PORT` | HTTP listen port (default `9090`) |
| `ORCHESTRATOR_DRY_RUN` | In-memory store; skip Kubernetes (`true` locally) |
| `ORCHESTRATOR_CONTROLLER_ENABLED` | Register reconcile controllers when not dry-run |
| `SANDBOX_NAMESPACE` | Namespace for Sandbox CRs |
| `FIRECRACKER_NAMESPACE` | Namespace for FirecrackerHost / Machine CRs |
| `SANDBOX_DEFAULT_RUNTIME` | Default runtime / snapshot (`nextjs`) |
| `FIRECRACKER_HOST_URL` | Default host daemon URL (dry-run / fallback) |
| `RUNTIME_URL` | Fallback guest runtime URL |
| `ORCHESTRATOR_NODE_REGISTER_ENABLED` | Auto-register labeled KVM nodes as hosts |
| `FIRECRACKER_NODE_LABEL` | Node label for in-cluster host discovery |
| `ORCHESTRATOR_EXTERNAL_HOSTS` / `_FILE` | Path B external EC2 host list |

See `.env.sample` for a full starter file. Concept mapping: [docs/devin-alignment.md](../../docs/devin-alignment.md). Host ops: [infra/README.md](../../infra/README.md).
