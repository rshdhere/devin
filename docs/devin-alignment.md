# Devin.ai alignment

How devin.baby maps to [Devin](https://devin.ai) concepts and where we intentionally differ.

## Concept mapping

| Devin.ai | devin.baby |
|----------|------------|
| **Session** | Task + persistent **devbox** (`sessionActive` / `sessionSleeping`) |
| **Devbox** | Firecracker microVM (dumb tool executor: shell/files/git/desktop) |
| **Brain** | `apps/brain` — control plane + **OpenAI harness** (`apps/brain/src/harness`) |
| **Tool RPC** | Go `apps/tool-gateway` gRPC `DevboxTools` → guest runtime HTTP |
| **Execution worker** | `apps/scheduler` with `SERVICE_MODE=worker` (provision / proxy) |
| **Blueprint / snapshot** | `/var/lib/devin/snapshots/{agent,nextjs}` on execution host |
| **Auto-PR (default SDLC)** | `finalizeGitWork` opens PR when `requireReviewBeforePush=false` |
| **Manual review gate** | `requireReviewBeforePush=true` → `awaiting_review` + Commit / Raise PR |
| **Follow-up in session** | `POST /tasks/:id/continue` reuses or wakes devbox |
| **Terminate session** | `POST /tasks/:id/terminate` deletes sandbox CR |

## Sandbox lifecycle (Devin-like)

1. **Boot** — Orchestrator creates `Sandbox` CR → firecracker starts microVM from snapshot (~warm pool).
2. **Work** — Brain harness calls tools over gRPC; gateway hits runtime HTTP in the guest. Events stream to the web UI.
3. **Persist** — Devbox stays alive after agent run for follow-ups until user ends session, idle sleep, or explicit terminate.
4. **Idle sleep** — After `DEVBOX_IDLE_TIMEOUT_SECONDS` (default 30m), sandbox phase → `Suspended`; session row kept in Postgres; wake on continue or `POST /tasks/:id/wake`.
5. **Ship** — Default: auto-push + open PR. Optional: pause at review when user enables manual review in dashboard settings.
6. **Teardown** — Explicit **End session** or post-commit finalize deletes orchestrator sandbox.

## Architecture: Brain vs execution host

```
Web UI → API server → Brain (Postgres + OpenAI harness)
                         ↓ provision job
                    Worker (execution host)
                         ↓ orchestrator + firecracker
                    Runtime HTTP in microVM
                         ↑
                    tool-gateway gRPC (Go) ← Brain harness tool calls
```

- **Brain**: durable tasks/events/sessions; runs the LLM loop; holds `OPENAI_API_KEY`.
- **Worker**: sandboxes, runtime proxy, queue consumer; dials local `TOOL_GATEWAY_GRPC_URL` (default `127.0.0.1:9095`).
- **tool-gateway**: typed Devbox tools on the execution host — no in-guest Cursor/Claude CLIs.

## Agent provider

Product agent is **`brain` only** (cheap OpenAI models via `OPENAI_MODEL`, default `gpt-4o-mini`). Internal `mock` remains for template-scaffold verify when `ALLOW_TEMPLATE_AGENT=true`.

In-guest Cursor Agent and Claude Code CLIs have been removed from the runtime.
