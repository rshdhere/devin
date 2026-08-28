# Devin

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/rshdhere/devin)
[![Build-Check](https://github.com/rshdhere/devin/actions/workflows/build.yaml/badge.svg?branch=main)](https://github.com/rshdhere/devin/actions/workflows/build.yaml)

[![Watch the Devin demo](https://img.youtube.com/vi/CLgbkPEXK9k/maxresdefault.jpg)](https://youtu.be/CLgbkPEXK9k)

**devin.baby** is a baby devin focused on the core software-engineering loop : submit work, get an isolated runtime, run the agent, stream progress, and persist results in `/workspace`.

## Architecture

[![Devin architecture: Firecracker microVMs, Cursor agent loop, SSE events, and desktop preview](docs/architecture.png)](https://excalidraw.com/#json=5hx4jjSPP5SmJVDGtZb_p,9O029vHsNP2hqMHxNco6pQ)

Click the diagram to open the [interactive architecture overview](https://excalidraw.com/#json=5hx4jjSPP5SmJVDGtZb_p,9O029vHsNP2hqMHxNco6pQ) in Excalidraw.

## Concept mapping

How devin.baby maps to [Devin](https://devin.ai) concepts:

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

## Sandbox lifecycle

1. **Boot** — Worker provisions `Sandbox` CR → firecracker starts microVM from snapshot (~warm pool).
2. **Ready** — Worker persists session, sets `runtime_ready`, notifies Brain (`POST .../sandbox-ready`). No guest IPs leave the host.
3. **Work** — **Brain** runs `runBrainHarness` (OpenAI). Every tool call: Brain → worker `/api/v1/tasks/:id/tools` → local tool-gateway `:9095` → guest. Events emit on Brain → Postgres + SSE.
4. **Finalize** — Brain calls worker `agent-complete`; worker runs git push / retain session / desktop snapshot.
5. **Persist** — Devbox stays alive after agent run for follow-ups until user ends session, idle sleep, or explicit terminate. Same microVM is retained for Interactive / continue for up to `SESSION_RETENTION_DAYS` (default **30**).
6. **Idle sleep** — After `DEVBOX_IDLE_TIMEOUT_SECONDS` (default 30m), sandbox phase → `Suspended`; session row kept in Postgres; wake on Interactive desktop, continue, or `POST /tasks/:id/wake`.
7. **Ship** — Default: auto-push + open PR. Optional: pause at review when user enables manual review in dashboard settings.
8. **Teardown** — Explicit **End session**, post-commit finalize, or retention expiry deletes the orchestrator sandbox. Capacity pressure may detach an idle retained VM while keeping session metadata for recoverSession.

Product agent is **`brain` only** (cheap OpenAI models via `OPENAI_MODEL`, default `gpt-4o-mini`). Internal `mock` remains for template-scaffold verify when `ALLOW_TEMPLATE_AGENT=true`.
