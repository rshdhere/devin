# `@devin/brain`

Cloud control plane for task orchestration. Mirrors Devin’s **brain**: durable task/session state in Postgres, OpenAI harness, with Devbox work delegated to an execution-host worker.

In Devin’s architecture, the brain is the cloud service that drives intelligence while the **Devbox** runs code — see [Enterprise Deployment](https://docs.devin.ai/enterprise/deployment/overview) (Brain vs Devbox).

## Role

```text
Web UI → API server → Brain (:9092)
                         │  OpenAI harness (src/harness)
                         │  POST /internal/v1/jobs  (sandbox provision only)
                         ▼
                    Scheduler worker (execution host)
                         │  firecracker microVM + session
                         │  POST Brain .../sandbox-ready
                         ▼
                    Brain harness tool calls
                         │  POST Worker /api/v1/tasks/:id/tools
                         ▼
                    tool-gateway gRPC (:9095) → runtime HTTP
```

- Accepts task create / retry / continue / terminate / wake
- Persists tasks, events, and sessions when `DATABASE_URL` is set
- Runs the Brain harness under `src/harness` after worker `sandbox-ready`
- Tools reach the Devbox only via the worker tool proxy (never guest CNI from EKS)
- Delegates sandbox provision via `EXECUTION_WORKER_URL`
- Runs `@devin/scheduler` with `mode: "brain"`
- Holds `OPENAI_API_KEY` (not on the execution host)

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
| `ORCHESTRATOR_URL`     | Orchestrator base URL (optional on Brain)    |
| `DEFAULT_AGENT`        | `brain` (product); `mock` for template verify |
| `OPENAI_API_KEY`       | OpenAI key for Brain harness                 |
| `OPENAI_MODEL`         | Harness model (default `gpt-4o-mini`)        |

Worker hosts need `BRAIN_INTERNAL_URL` (this service) so they can `POST .../sandbox-ready`, plus local `TOOL_GATEWAY_GRPC_URL=127.0.0.1:9095`. They do **not** need `OPENAI_API_KEY` for product brain tasks.

See `.env.sample` for a starter file. Ops notes: [docs/brain-and-postgres.md](../../docs/brain-and-postgres.md). Concept mapping: [docs/devin-alignment.md](../../docs/devin-alignment.md).
