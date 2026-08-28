# `@devin/runtime`

Guest **supervisor** that runs inside each Firecracker microVM — the in-box half of Devin’s **Devbox**. Scheduler and orchestrator provision the VM; this process exposes shell, git, files, agent runs, and SSE events over HTTP on the guest.

In Devin’s architecture, the Devbox is where code executes while the brain stays in the cloud — see [Enterprise Deployment](https://docs.devin.ai/enterprise/deployment/overview) (Brain vs Devbox) and [VPC overview](https://docs.devin.ai/enterprise/vpc/overview) (DevBox components: shell, editor, browser).

## Role

```text
Scheduler worker
        ↓ RUNTIME_URL (:8081)
Runtime supervisor (this app, inside microVM)
        ↓ /workspace (tmpfs on Linux)
Cursor / Claude / mock agent + git / shell / files
```

- Prepares `/workspace` (tmpfs mount on Linux guests)
- Ensures guest DNS + entropy for TLS / package installs
- Runs coding agents asynchronously and streams task events
- Serves terminal, git, and file APIs used by the web IDE panels

## Layout

```text
cmd/runtime/           # Entrypoint
internal/
  supervisor/          # HTTP API (run, git, files, terminal, events)
  agent/               # Cursor / Claude / mock runners
  executil/            # Process exec + streaming helpers
  events/              # In-memory SSE event bus
  workspace/           # tmpfs, DNS, entropy (Linux build tags)
```

## API

| Method   | Path               | Purpose                          |
| -------- | ------------------ | -------------------------------- |
| `GET`    | `/health`          | Liveness                         |
| `POST`   | `/dns/ensure`      | Re-apply guest DNS resolvers     |
| `GET`    | `/logs`            | Recent supervisor log lines      |
| `POST`   | `/run`             | Start an agent run (async)       |
| `GET`    | `/run/status`      | Poll run status (`?taskId=`)     |
| `POST`   | `/terminal`        | Run a shell command              |
| `POST`   | `/terminal/stream` | Stream command output (SSE)      |
| `POST`   | `/git/clone`       | Shallow clone into workspace     |
| `POST`   | `/git/commit`      | Stage + commit                   |
| `POST`   | `/git/push`        | Push to remote                   |
| `POST`   | `/files/write`     | Write a file under workspace     |
| `GET`    | `/files/list`      | List directory (`?path=`)        |
| `GET`    | `/files/read`      | Read file preview (`?path=`)     |
| `POST`   | `/browser/open`    | Record a URL for the browser UI  |
| `GET`    | `/events`          | Task event SSE (`?taskId=`)      |

Default listen port: **8081** (`RUNTIME_PORT`).

Optional `X-Runtime-Env` header: JSON object of env vars applied to terminal / git commands.

## Develop

```bash
cp apps/runtime/.env.sample apps/runtime/.env
# AGENT_PROVIDER=mock by default
bun run --cwd apps/runtime dev
```

Build and run the binary:

```bash
bun run --cwd apps/runtime build
bun run --cwd apps/runtime start
```

Point `RUNTIME_URL` on brain / scheduler / firecracker at `http://localhost:8081` (or the guest IP in production).

## Key env

| Variable | Purpose |
| -------- | ------- |
| `RUNTIME_PORT` | HTTP listen port (default `8081`) |
| `RUNTIME_WORKSPACE` | Workspace root (default `/workspace`) |
| `AGENT_PROVIDER` / `DEFAULT_AGENT` | `mock` \| `cursor` \| `claude` |
| `CURSOR_API_KEY` / `ANTHROPIC_API_KEY` | Credentials for real agents |
| `CURSOR_AGENT_BIN` / `CLAUDE_CODE_BIN` | Override agent binary paths |
| `AGENT_MODEL` | Optional model override |
| `AGENT_RUN_TIMEOUT_MIN` | Agent run timeout (minutes) |

See `.env.sample` for a starter file. Concept mapping: [README.md](../../README.md#concept-mapping).
