# MicroVM guardrails

Firecracker execution hosts copy a golden `rootfs.ext4` into `/var/lib/devin/vms/<vm-id>/` for every microVM. Without guardrails, stale VM dirs and concurrent clones can fill host disk and cause `clone golden rootfs` / `No space left on device` failures.

See also: [apps/firecracker/README.md](../apps/firecracker/README.md), [infra/deployment.md](../infra/deployment.md).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIRECRACKER_MAX_ACTIVE_VMS` | `2` | Cap concurrent microVMs on this host (`0` disables) |
| `FIRECRACKER_MIN_FREE_DISK_GIB` | `12` | Refuse create/warm when free space under `FIRECRACKER_VMM_DIR` is below this |
| `FIRECRACKER_ORPHAN_PRUNE_INTERVAL_SEC` | `300` | Periodic prune of stale VM dirs under `/var/lib/devin/vms` (`0` disables) |

Defaults are set in [apps/firecracker/.env.sample](../apps/firecracker/.env.sample) and the host systemd unit in [infra/internal/host/deploy.go](../infra/internal/host/deploy.go).

## Behavior

- **Startup prune** — On firecracker start, orphan directories under `FIRECRACKER_VMM_DIR` are removed.
- **Periodic prune** — A background loop prunes orphans while keeping in-use VM ids.
- **Disk guard** — `GuardMinFreeDisk` blocks VM create and warm-pool launches when host free space is too low.
- **Concurrency guard** — Create is refused when tracked microVMs reach `FIRECRACKER_MAX_ACTIVE_VMS`; warm pool also respects tracked + queued VMs.
- **ENOSPC retry** — Rootfs clone retries once after an orphan prune if the copy hits host ENOSPC.
- **Host status** — `GET /v1/status` exposes `freeDiskGiB`, `maxActiveVMs`, `minFreeDiskGiB`, and `activeVMs`.

## Host ENOSPC vs guest tmpfs

| Symptom | Where | What to do |
|---------|--------|------------|
| `clone golden rootfs` / `No space left` while copying to `/var/lib/devin/vms/...` | **Execution host** disk | Free `/var/lib/devin` (stale VM dirs). Firecracker prunes orphans on start + periodically, and blocks creates below `FIRECRACKER_MIN_FREE_DISK_GIB`. Ops: `sudo devin-infra free-disk` when available. |
| `host disk guardrail` / `host active VM guardrail` in task errors | **Execution host** policy | Free disk or wait for active sandboxes to finish; raise limits or add hosts if sustained. |
| ENOSPC mid-run inside the guest (pip/npm/cargo caches) | Guest **workspace tmpfs** | Retry after runtime with 8G tmpfs + cache pruning; do not confuse with rootfs clone failures. |

## Recovery

1. On the execution host: `sudo devin-infra free-disk` (when available) or manually remove stale dirs under `/var/lib/devin/vms`.
2. Redeploy or restart firecracker so startup prune runs and new guardrail env vars apply.
3. Retry the failed task in the UI.

## HydraDB and sandbox create

HydraDB will not show new prompt ingest rows for tasks that die at sandbox create (host ENOSPC or guardrail refusal) — Brain only seeds memory after `sandbox-ready`. Fix host disk first, then confirm Progress shows `HydraDB prompt memory seeded` and open the **user id** collection in HydraDB Logs (not `probe-*`).
