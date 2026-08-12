# Devin.ai alignment

How devin.baby maps to [Devin](https://devin.ai) concepts and where we intentionally differ.

## Concept mapping

| Devin.ai | devin.baby |
|----------|------------|
| **Session** | Task + persistent **devbox** (`sessionActive` / `sessionSleeping`) |
| **Devbox** | Firecracker microVM from golden snapshot (`agent` or `nextjs`) |
| **Brain** | `apps/brain` — cloud control plane (Postgres + job delegation) |
| **Execution worker** | `apps/scheduler` with `SERVICE_MODE=worker` on execution host |
| **Blueprint / snapshot** | `/var/lib/devin/snapshots/{agent,nextjs}` on execution host |
| **Auto-PR (default SDLC)** | `finalizeGitWork` opens PR when `requireReviewBeforePush=false` |
| **Manual review gate** | `requireReviewBeforePush=true` → `awaiting_review` + Commit / Raise PR |
| **Follow-up in session** | `POST /tasks/:id/continue` reuses or wakes devbox |
| **Terminate session** | `POST /tasks/:id/terminate` deletes sandbox CR |

## Sandbox lifecycle (Devin-like)

1. **Boot** — Orchestrator creates `Sandbox` CR → firecracker starts microVM from snapshot (~warm pool).
2. **Work** — Runtime supervisor in VM executes shell, git, and agent CLI. Brain/worker streams events to web UI.
3. **Persist** — Devbox stays alive after agent run for follow-ups until user ends session, idle sleep, or explicit terminate.
4. **Idle sleep** — After `DEVBOX_IDLE_TIMEOUT_SECONDS` (default 30m), sandbox phase → `Suspended`; session row kept in Postgres; wake on continue or `POST /tasks/:id/wake`.
5. **Incremental commits** — Auto-commit watcher checkpoints dirty git state during long agent runs (Devin SDLC pattern).
6. **Ship** — Default: auto-push + open PR. Optional: pause at review when user enables manual review in dashboard settings.
7. **Teardown** — Explicit **End session** or post-commit finalize deletes orchestrator sandbox.

## Architecture: Brain vs execution host

```
Web UI → API server → Brain (cloud, DATABASE_URL)
                         ↓ POST /internal/v1/jobs
                    Scheduler worker (execution host, SERVICE_MODE=worker)
                         ↓ orchestrator + firecracker
                    Runtime supervisor in microVM (agent CLI)
```

- **Brain** (`BRAIN_PORT`, default 9092): durable tasks/events/sessions in Postgres; delegates sandbox work to worker via `EXECUTION_WORKER_URL`.
- **Worker** (`SCHEDULER_PORT`, default 9091): runs queue consumer, sandboxes, runtime proxy; writes through same Postgres when `DATABASE_URL` is set.
- **Standalone** (default): single scheduler on execution host with optional Postgres durability.

Set `SCHEDULER_URL` on the API server to the brain URL in cloud deployments.

## Interactive workspace (web UI)

| Panel | API | Notes |
|-------|-----|-------|
| **Shell** | `POST /tasks/:id/terminal` (`stream: true`) | Streaming command output from devbox |
| **Files** | `GET /tasks/:id/files`, `/files/read` | Repo file tree + read-only preview |
| **Browser** | Embedded iframe when a legacy `previewUrl` exists | Preview deploy is not supported — Devin pushes to GitHub only |
| **Desktop** | `GET /tasks/:id/desktop-screenshot` | Playwright/Chromium capture of localhost in the devbox |
| **Interactive desktop** | `GET /tasks/:id/desktop-vnc` | noVNC stream with mouse/keyboard (1024×768 Xvfb) |
| **CDP** | port `29229` in guest | Playwright `connectOverCDP` attaches to persistent Chromium |
| **Session recording** | `GET /tasks/:id/session-recording` | ffmpeg x11grab WebM, uploaded to S3 on agent completion |

Desktop snapshots:

1. Probe any listening TCP port (via `ss`), spin up npm/uvicorn when needed, capture with Playwright.
2. Cache PNG on the execution host under `DEVIN_SNAPSHOT_DIR` (production: `/var/lib/devin/task-snapshots`).
3. Persist PNG + preview port on `agent_sessions` (`desktop_snapshot` bytea, `preview_port`) so brain/worker restarts and sleep/wake still serve the last capture.
4. Pass `?fresh=1` to bypass caches and recapture.

## Durable sessions (Postgres)

Migrations `0003_agent_sessions.sql` and `0004_desktop_snapshot.sql` add:

- `agent_tasks` — task state (survives scheduler/brain restart)
- `agent_task_events` — append-only event log for SSE replay
- `agent_sessions` — devbox lease metadata (`active` / `review` / `sleeping`), plus `preview_port` and `desktop_snapshot`

On startup, scheduler/worker calls `TaskService.initialize()` to restore tasks, events, and reconnect live sessions when runtime health succeeds.

## Execution flow

### Runtime agents (Cursor / Claude) — default

```
Prompt → boot devbox → clone repo in VM → agent.runAndWait
       → [optional review] → auto-PR or manual Commit/PR
       → devbox kept for follow-ups (sleep when idle)
```

No OpenAI draft on the control plane. Greenfield repos get a README shell on GitHub; the agent implements in the devbox.

### Template agent (`mock`) — legacy

OpenAI plan → control-plane scaffold push → `nextjs` snapshot verify. Kept for backwards compatibility only.

## Control plane vs devbox

| Control plane (brain / API) | Devbox (microVM runtime) |
|----------------------------|---------------------------|
| Task queue, Postgres sessions | Shell, git, npm, agent CLI |
| GitHub API (create repo, open PR) | `git clone`, commit, push |
| SSE event bus + DB replay | File writes |
| Orchestrator sandbox CR | `/workspace` on tmpfs |

## Settings

- **Dashboard → GitHub permissions → Require review before push** — mirrors opting out of Devin's default auto-PR; when off (default), behavior matches Devin SDLC integration.
- **GitHub permission toggles** — same as Devin org permission rules (commit, push, PR, repo create).

## Future parity

- Devbox outbound WebSocket registration to brain (today: worker HTTP proxy)
- Firecracker guest snapshot on hard sleep (today: soft suspend phase, VM kept)
- Full IDE (Monaco edit + save)
- Org blueprints with pre-cloned repos in snapshot

## Operations

- `SCHEDULER_HOST_NAME` must match `FirecrackerHost` CR name (pins devbox to execution host).
- Cloud: `DATABASE_URL` on brain + worker; `EXECUTION_WORKER_URL` on brain; `SCHEDULER_URL` on API → brain.
- Run `sudo devin-infra sync-platform-config` after SSM or image updates.
- Apply migrations through `0005_session_recording.sql` (preview port, desktop PNG, recording key on `agent_sessions`).
- Execution hosts: `DEVIN_SNAPSHOT_DIR=/var/lib/devin/task-snapshots` (mounted into the scheduler container).
- Optional: `DEVIN_RECORDING_S3_BUCKET` (falls back to `DEVIN_SNAPSHOT_S3_BUCKET`) for session WebM recordings.
