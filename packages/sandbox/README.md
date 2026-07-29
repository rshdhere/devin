# `@devin/sandbox`

Kubernetes CRD types for Devin sandboxes and Firecracker execution hosts.

This package is the API surface shared by the orchestrator controllers and any
tool that creates or inspects sandbox resources.

## Types (`api/v1`)

| Kind | Purpose |
| ---- | ------- |
| `Sandbox` | Desired microVM for a task (runtime, CPU, memory, preferredHost) |
| `FirecrackerMachine` | Concrete VM lease on a host |
| `FirecrackerHost` | Execution node registration and capacity |
| `Snapshot` | Named golden snapshot / runtime image metadata |

## Sandbox phases

`Pending` → `Provisioning` → `Running`, plus `Suspended` / `Waking`,
`Failed`, and `Terminating` / `Terminated`.

## Build

```bash
cd packages/sandbox
go build ./...
go vet ./...
```

Module path: `github.com/rshdhere/devin/packages/sandbox`.
