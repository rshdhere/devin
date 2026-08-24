# Devin.ai alignment

How devin.baby maps to [Devin](https://devin.ai) concepts and where we intentionally differ.

## Concept mapping

| Devin.ai | devin.baby |
|----------|------------|
| **Session** | Task + persistent **devbox** (`sessionActive` / `sessionSleeping`) |
| **Devbox** | Firecracker microVM (dumb tool executor: shell/files/git/desktop) |
| **Brain** | `apps/brain` — control plane + **OpenAI harness** (`apps/brain/src/harness`) |
| **Tool RPC** | Brain → worker HTTP `/tools` → Go `apps/tool-gateway` gRPC → guest runtime HTTP |
| **Execution worker** | `apps/scheduler` with `SERVICE_MODE=worker` (provision / tool proxy / desktop) |
| **Blueprint / snapshot** | `/var/lib/devin/snapshots/{agent,nextjs}` on execution host |
| **Auto-PR (default SDLC)** | `finalizeGitWork` opens PR when `requireReviewBeforePush=false` |
| **Manual review gate** | `requireReviewBeforePush=true` → `awaiting_review` + Commit / Raise PR |
| **Follow-up in session** | `POST /tasks/:id/continue` reuses or wakes devbox |
| **Terminate session** | `POST /tasks/:id/terminate` deletes sandbox CR |

## Sandbox lifecycle (Devin-like)

1. **Boot** — Worker provisions `Sandbox` CR → firecracker starts microVM from snapshot (~warm pool).
2. **Ready** — Worker persists session, sets `runtime_ready`, notifies Brain (`POST .../sandbox-ready`). No guest IPs leave the host.
3. **Work** — **Brain** runs `runBrainHarness` (OpenAI). Every tool call: Brain → worker `/api/v1/tasks/:id/tools` → local tool-gateway `:9095` → guest. Events emit on Brain → Postgres + SSE.
4. **Finalize** — Brain calls worker `agent-complete`; worker runs git push / retain session / desktop snapshot.
5. **Persist** — Devbox stays alive after agent run for follow-ups until user ends session, idle sleep, or explicit terminate. Same microVM is retained for Interactive / continue for up to `SESSION_RETENTION_DAYS` (default **30**).
6. **Idle sleep** — After `DEVBOX_IDLE_TIMEOUT_SECONDS` (default 30m), sandbox phase → `Suspended`; session row kept in Postgres; wake on Interactive desktop, continue, or `POST /tasks/:id/wake`.
7. **Ship** — Default: auto-push + open PR. Optional: pause at review when user enables manual review in dashboard settings.
8. **Teardown** — Explicit **End session**, post-commit finalize, or retention expiry deletes the orchestrator sandbox. Capacity pressure may detach an idle retained VM while keeping session metadata for recoverSession.

## Architecture: Brain vs execution host

```
Web UI → API server → Brain (Postgres + OpenAI harness + OPENAI_API_KEY)
                         │  POST /internal/v1/jobs  (sandbox only)
                         ▼
                    Worker (execution host)
                         │  orchestrator + firecracker + clone
                         │  POST Brain .../sandbox-ready
                         ▼
                    Brain runBrainHarness
                         │  POST Worker .../tools (taskId)
                         ▼
                    tool-gateway gRPC (:9095) → Runtime HTTP in microVM
                         ▲
                    Worker agent-complete (git finalize / retain)
```

- **Brain**: durable tasks/events/sessions; runs the LLM loop; holds `OPENAI_API_KEY`; never dials `192.168.127.x`.
- **Worker**: sandboxes, tool proxy, desktop/files/git proxy, queue consumer; dials local `TOOL_GATEWAY_GRPC_URL` (default `127.0.0.1:9095`). No OpenAI key required for product `brain` tasks.
- **tool-gateway**: typed Devbox tools on the execution host — no in-guest Cursor/Claude CLIs.
- **`SERVICE_MODE=standalone`**: local DX keeps sandbox + harness colocated (direct gRPC to localhost gateway).

## Agent provider

Product agent is **`brain` only** (cheap OpenAI models via `OPENAI_MODEL`, default `gpt-4o-mini`). Internal `mock` remains for template-scaffold verify when `ALLOW_TEMPLATE_AGENT=true`.

In-guest Cursor Agent and Claude Code CLIs have been removed from the runtime.
