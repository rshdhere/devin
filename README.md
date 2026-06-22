# Devin (devin.baby)

**devin.baby** is a mini Devin focused on the core software-engineering loop: submit work, get an isolated runtime, run the agent, stream progress, and persist results in `/workspace`.

Sandboxes are an internal implementation detail. Users submit **Tasks**.

## Architecture

Kubernetes is the **control plane**. Firecracker microVMs are the **execution plane**. The runtime HTTP contract never changes — the agent only knows `POST /run`, `POST /terminal`, `POST /git/*`, and `GET /events`.

```mermaid
flowchart TB
  User --> Web
  Web --> Server
  Server --> Scheduler
  Scheduler --> Queue
  Queue --> Orchestrator
  Orchestrator --> SandboxCRD["Sandbox CRD"]
  SandboxController --> SandboxCRD
  SandboxController --> MachineCRD["FirecrackerMachine CR"]
  MachineController --> MachineCRD
  MachineController --> HostSelect["Firecracker Host Selection"]
  HostSelect --> FCHost["firecracker-host daemon"]
  FCHost --> SnapshotPool["Warm Snapshot Pool"]
  SnapshotPool --> microVM["Firecracker microVM"]
  microVM --> Runtime["Runtime Supervisor"]
  Scheduler --> Runtime
  Runtime --> Agent
  Scheduler --> Events
  Events --> Web
```

### Request flow

1. User → `POST /api/v1/tasks` `{ "prompt": "...", "agent": "cursor" }`
2. **Server** authenticates and forwards to **Scheduler**
3. **Scheduler** enqueues work and emits `task.created`
4. Worker creates a **Sandbox CRD** via **Orchestrator** (internal API)
5. **Sandbox controller** creates a **FirecrackerMachine CR** (no Pods)
6. **Machine controller** selects a **FirecrackerHost**, clones a warm snapshot, boots the microVM
7. **Runtime supervisor** starts inside the VM and exposes the fixed HTTP contract
8. Scheduler opens `GET /events?taskId=...` and calls `POST /run` with the selected agent
9. **Cursor CLI** or **Claude Code** runs headlessly inside `/workspace`
10. Agent output streams over SSE: `GET /api/v1/tasks/{id}/events`
11. Scheduler deletes the sandbox when the task finishes

### Agent workflow

Tasks choose an **agent provider** that runs inside the sandbox microVM:

| Agent | CLI | Auth env | Runtime image |
| --- | --- | --- | --- |
| `mock` | built-in planner | none | `nextjs` (local dev default) |
| `cursor` | `agent -p --force --trust` | `CURSOR_API_KEY` | `agent` |
| `claude` | `claude -p --bare` | `ANTHROPIC_API_KEY` | `agent` |

The scheduler never shells into the host. It only talks HTTP to the runtime supervisor, which invokes the agent CLI inside the Firecracker VM:

```text
POST /tasks
  → Sandbox CRD (runtime=agent)
  → Firecracker microVM
  → POST /run { taskId, prompt, agent }
  → cursor-cli | claude-code
  → GET /events?taskId=...  (agent.log, agent.tool, git.*)
  → SSE /tasks/{id}/events
```

Create a task with Cursor or Claude Code:

```sh
curl -X POST http://localhost:8080/api/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Add JWT auth to the Next.js app","agent":"cursor"}'
```

For local development without API keys, omit `agent` or set `"agent":"mock"`. The mock agent writes `AGENT_TASK.md`, initializes git, and commits a plan so the full workflow can be tested end-to-end.

### Repository layout

```
devin/
├── apps/
│   ├── web/                 # Dashboard
│   ├── server/              # API gateway (auth + task proxy)
│   ├── scheduler/           # Task queue worker + SSE events
│   ├── orchestrator/        # Sandbox CRD controller + internal API
│   ├── firecracker-host/    # Node daemon: VM pool + snapshot manager
│   └── runtime/             # In-VM supervisor (PID 1)
├── packages/
│   ├── orchestrator/        # K8s reconciliation logic
│   ├── sandbox/             # Sandbox + Firecracker CRD types
│   ├── scheduler/           # Task scheduling library
│   ├── services/
│   │   ├── email/           # Resend client
│   │   └── queue/           # Task queue (memory + SQS)
│   ├── events/              # Event bus + SSE helpers
│   └── agent-sdk/           # Runtime HTTP client contract
├── deploy/
│   └── helm/                # Helm chart scaffold
└── runtime-images/          # agent, nextjs, go, rust, node, python → snapshots
```

### Kubernetes namespaces

| Namespace | Workloads |
| --- | --- |
| `devin-app` | web, server |
| `devin-system` | orchestrator |
| `devin-sandboxes` | Sandbox + FirecrackerMachine CRs |
| `devin-firecracker` | firecracker-host DaemonSet, scheduler DaemonSet, FirecrackerHost CRs |

### Runtime supervisor API

Every microVM runs the same runtime supervisor:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/run` | Execute agent task |
| POST | `/terminal` | Shell commands |
| POST | `/git/clone` | Clone repository |
| POST | `/git/commit` | Commit changes |
| POST | `/files/write` | Write workspace files |
| POST | `/browser/open` | Browser automation |
| GET | `/health` | Liveness |
| GET | `/logs` | Supervisor logs |
| GET | `/events` | Runtime event stream |

The orchestrator **never** executes shell commands — it only provisions infrastructure and talks to the runtime over HTTP.

### CRDs

| Kind | Purpose |
| --- | --- |
| `Sandbox` | Task-facing sandbox intent (`taskId`, `runtime`, `cpu`, `memory`) |
| `FirecrackerMachine` | Controller-managed microVM for a sandbox |
| `FirecrackerHost` | Node capacity + firecracker-host API address |
| `Snapshot` | Golden snapshot metadata per runtime image |

### Warm snapshots

Production hosts maintain a pool of ready microVMs restored from golden snapshots (~300ms) instead of cold booting kernels (~8–12s). Each `runtime-images/*` directory builds a snapshot consumed by `firecracker-host`.

Build snapshots on a Linux Firecracker host:

```sh
go build -o apps/runtime/bin/runtime ./apps/runtime/cmd/runtime
sudo ./scripts/build-firecracker-rootfs.sh nextjs devin-runtime-nextjs:latest
sudo ./scripts/build-firecracker-snapshot.sh nextjs
```

Set `FIRECRACKER_DRY_RUN=false` on `firecracker-host` to enable snapshot restore via the Firecracker SDK + CNI (`fcnet`).

### Swappable execution backends

The scheduler → HTTP → runtime path works whether the runtime lives in a Pod, Firecracker VM, Kata, or gVisor. Only the controller + host layer changes.

## Local development

```sh
bun install

# terminal 1 — firecracker-host (dry-run VM pool)
bun run dev --filter=@devin/firecracker-host

# terminal 2 — orchestrator (dry-run, calls firecracker-host)
ORCHESTRATOR_DRY_RUN=true bun run dev --filter=@devin/orchestrator-app

# terminal 3 — runtime supervisor
bun run dev --filter=@devin/runtime

# terminal 4 — scheduler worker
bun run dev --filter=@devin/scheduler-app

# terminal 5 — API + web
bun run dev --filter=@devin/server
bun run dev --filter=@devin/web
```

Create a task:

```sh
curl -X POST http://localhost:8080/api/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Build a Next.js auth system"}'
```

Stream events:

```sh
curl -N http://localhost:9091/api/v1/tasks/{taskId}/events
```

## Kubernetes deploy

Kubernetes manifests live in your **GitOps repository** (not this app repo). See `migration.md` for the full manifest bundle, overlay layout, and Argo CD / Flux wiring.

Production on **AWS** uses Path B (EKS + external EC2 execution hosts + Neon). Operational procedures — snapshots, EC2 hosts, Neon, ingress — are in `deployment.md`.

Sync the control plane from GitOps:

- **Path B (recommended):** `apps/devin-baby/overlays/<env>-external`
- **Path A (in-cluster KVM):** `apps/devin-baby/overlays/<env>-in-cluster` + label workers `devin.baby/firecracker-host=true`

Set on server: `DATABASE_URL` to your Neon connection string; `SCHEDULER_URL` to your execution host scheduler URL (`http://<private-ip>:9091`).

## Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Start all apps |
| `bun run build` | Build all apps and packages |
| `bun run lint` | Lint the monorepo |
| `bun run check-types` | TypeScript type checking |
