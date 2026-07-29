# `@devin/orchestrator`

Kubernetes controllers that turn Sandbox CRs into Firecracker microVMs.

The scheduler POSTs sandbox specs to the orchestrator HTTP API. Controllers
reconcile those CRs by selecting a FirecrackerHost, creating a
FirecrackerMachine, and calling the host daemon to boot (or wake) a VM.

## Layout

```text
config/       # Env-driven controller configuration
host/         # HTTP client for the Firecracker host daemon
reconcile/    # Controllers: sandbox, machine, host status, node pool
store/        # CR / host store backends (Kubernetes + memory)
```

## Controllers

| Reconciler | Responsibility |
| ---------- | -------------- |
| Sandbox | Ensure a Machine exists; mirror phase / runtimeURL |
| FirecrackerMachine | Provision / suspend / wake / delete VMs on a host |
| Host status | Refresh capacity and warm-pool readiness |
| Node pool | Register labeled nodes as FirecrackerHost CRs |

## Build / test

```bash
cd packages/orchestrator
go build ./...
go test ./...
go vet ./...
```

Module path: `github.com/rshdhere/devin/packages/orchestrator` (depends on
`packages/sandbox` CRD types).
