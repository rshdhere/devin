# `@devin/scheduler`

Task orchestration: queue jobs, provision sandboxes, drive the runtime agent,
stream events, and manage previews.

Consumed by `apps/scheduler` / `apps/brain` via:

```ts
import { startSchedulerServer } from "@devin/scheduler/start-server";
```

## Layout

```text
src/
  index.ts                 # Public barrel
  start-server.ts          # Thin HTTP server bootstrap (package export)
  server/
    host-registration.ts   # FirecrackerHost register + refresh
    routes.ts              # Express top-level router
    task-routes.ts         # Express /api/v1/tasks router
    task-events.ts         # SSE event stream
  task/
    service.ts             # Core task lifecycle (TaskService)
    store.ts               # Durable tasks / sessions / events
    types.ts               # Scheduler-local task/job types
  agent/
    defaults.ts            # Default agent resolution
  host/
    preferred-host.ts      # SCHEDULER_HOST_NAME / preferred Firecracker host
    register-execution-host.ts
  greenfield/
    bootstrap.ts           # New-repo workspace setup
    draft-planner.ts       # Draft plan generation
    scaffold-from-draft.ts
    shell-scaffold.ts      # Thin package.json / lock scaffold
    git-sync.ts            # Align / push greenfield repos
    project-metadata.ts    # Titles and repo name picks
  github/
    client.ts              # GitHub repo / PR / issue helpers
  preview/
    registry.ts            # Preview slug routing
    proxy.ts               # Host-based preview proxy
    deploy.ts              # Production preview deploy
  diagnostics/
    collect.ts             # Infra / sandbox / host probes
```

## Responsibilities

1. Accept create / retry / continue / terminate / wake requests
2. Reclaim capacity and provision sandboxes through the orchestrator
3. Clone or bootstrap greenfield repos, then run the Cursor/Claude agent
4. Publish activity on `@devin/events` and persist via `TaskStore`
5. Optionally deploy and proxy per-task previews

## Key env

| Variable                         | Purpose                                   |
| -------------------------------- | ----------------------------------------- |
| `ORCHESTRATOR_URL`               | Orchestrator base URL                     |
| `FIRECRACKER_HOST_URL`           | Host daemon for registration / probes     |
| `SCHEDULER_HOST_NAME`            | Preferred FirecrackerHost CR name         |
| `SANDBOX_CPU` / `SANDBOX_MEMORY` | Default sandbox sizing                    |
| Queue / preview vars             | See `start-server.ts` and preview modules |

## Develop

```bash
bun test packages/scheduler/src
```
