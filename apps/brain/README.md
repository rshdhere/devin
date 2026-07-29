# `@devin/brain`

Cloud control plane for task orchestration. Mirrors Devin’s **brain**: durable task/session state in Postgres, with sandbox work delegated to an execution-host worker.

In Devin’s architecture, the brain is the cloud service that drives intelligence while the **Devbox** runs code — see [Enterprise Deployment](https://docs.devin.ai/enterprise/deployment/overview) (Brain vs Devbox).

## Role

```text
Web UI → API server → Brain (:9092)
                         ↓ POST /internal/v1/jobs
                    Scheduler worker (execution host)
                         ↓ orchestrator + firecracker
                    Runtime agent in microVM
```

- Accepts task create / retry / continue / terminate / wake
- Persists tasks, events, and sessions when `DATABASE_URL` is set
- Delegates execution via `EXECUTION_WORKER_URL`
- Runs `@devin/scheduler` with `mode: "brain"`

Point the API server’s `SCHEDULER_URL` at this service in cloud deployments.

## Develop

```bash
bun install
bun run --cwd apps/brain dev
```

## Start

```bash
bun run --cwd apps/brain start
```

Default listen port: **9092** (`BRAIN_PORT`).

## Key env

| Variable               | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `BRAIN_PORT` / `PORT`  | HTTP listen port (default `9092`)            |
| `DATABASE_URL`         | Postgres for durable tasks / sessions        |
| `EXECUTION_WORKER_URL` | Worker scheduler on the execution host       |
| `ORCHESTRATOR_URL`     | Orchestrator base URL                        |
| `RUNTIME_URL`          | Runtime supervisor base URL                  |
| `DEFAULT_AGENT`        | `cursor` \| `claude` \| `mock`               |

See `.env.sample` for a starter file. Ops notes: [docs/brain-and-postgres.md](../../docs/brain-and-postgres.md). Concept mapping: [docs/devin-alignment.md](../../docs/devin-alignment.md).
