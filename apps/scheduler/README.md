# `@devin/scheduler-app`

Execution-host (or standalone) scheduler process. Boots `@devin/scheduler` to queue tasks, provision Devboxes via the orchestrator, drive the guest runtime agent, and stream events.

In Devin’s architecture the **brain** plans in the cloud while the **Devbox** runs code on an execution host — see [Enterprise Deployment](https://docs.devin.ai/enterprise/deployment/overview) (Brain vs Devbox). This app is the worker-side process that sits next to Firecracker and talks to the guest runtime.

Shared library: [`packages/scheduler`](../../packages/scheduler/README.md). Cloud control plane variant: [`apps/brain`](../brain/README.md) (`mode: "brain"`).

## Role

```text
Web UI → API server → Brain (:9092)          # cloud
                         ↓ jobs
Scheduler worker (this app, :9091)          # execution host
                         ↓ orchestrator + firecracker
                    Runtime supervisor (:8081) in microVM
```

| `SERVICE_MODE` | Behavior |
| -------------- | -------- |
| `standalone` (default) | Single process: accept tasks and run sandboxes locally |
| `worker` | Execution host behind brain; consumes delegated jobs |
| `brain` | Prefer [`apps/brain`](../brain/README.md) instead |

## Layout

```text
src/
  main.ts    # Exported bootstrap (env → startSchedulerServer)
  bin.ts     # Process entrypoint
```

## Develop

```bash
cp apps/scheduler/.env.sample apps/scheduler/.env
bun run --cwd apps/scheduler dev
```

## Start

```bash
bun run --cwd apps/scheduler start
```

Default listen port: **9091** (`SCHEDULER_PORT`).

## Key env

| Variable | Purpose |
| -------- | ------- |
| `SCHEDULER_PORT` | HTTP listen port (default `9091`) |
| `SERVICE_MODE` | `standalone` \| `worker` \| `brain` |
| `ORCHESTRATOR_URL` | Orchestrator base URL |
| `RUNTIME_URL` | Guest runtime fallback URL |
| `FIRECRACKER_HOST_URL` | Local firecracker daemon for registration / probes |
| `SCHEDULER_HOST_NAME` | Must match `FirecrackerHost` CR `metadata.name` |
| `EXECUTION_WORKER_URL` | Used when mode is brain (delegate sandbox work) |
| `DATABASE_URL` | Postgres for durable tasks / sessions |
| `DEFAULT_AGENT` | `cursor` \| `claude` \| `mock` |
| `QUEUE_DRIVER` | `memory` \| `sqs` |
| `SANDBOX_READY_TIMEOUT_SECONDS` | Wait for sandbox ready (default long for cold starts) |
| `DEVBOX_IDLE_TIMEOUT_SECONDS` | Idle sleep before suspend (default 30m) |

Agent credentials (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY`) and GitHub bot tokens belong on the execution host — see `.env.sample`.

Concept mapping: [README.md](../../README.md#architecture). Ops: [apps/brain/README.md](../brain/README.md#operations), [infra/README.md](../../infra/README.md).
