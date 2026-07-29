# `@devin/agent-sdk`

HTTP client for the sandbox runtime supervisor. The scheduler uses this to run
agents, shell commands, and git operations inside a provisioned microVM.

## Usage

```ts
import { RuntimeClient } from "@devin/agent-sdk";

const runtime = new RuntimeClient({
  baseUrl: "http://10.0.0.5:8081",
  fetchTimeoutMs: 35 * 60 * 1000,
});

await runtime.health();
await runtime.runAndWait({
  taskId: "…",
  prompt: "…",
  agent: "cursor",
  workDir: "repo",
});
```

## Capabilities

| Method | Runtime route | Purpose |
| ------ | ------------- | ------- |
| `run` / `runStatus` / `runAndWait` | `/run` | Start and poll agent runs |
| `terminal` | `/terminal` | Execute shell commands |
| `gitClone` / `gitCommit` / `gitPush` | `/git/*` | Repo operations in the VM |
| `writeFile` | `/files/write` | Write files into the workspace |
| `health` / `ensureDns` | `/health`, `/dns/ensure` | Readiness and DNS repair |

## Fetch timeouts

Long `/terminal` calls (installs, builds) exceed Node's default undici
`headersTimeout` (300s). On Node, the client installs an undici `Agent` with
timeouts aligned to `fetchTimeoutMs`. On Bun, undici is skipped and
`timeout: false` disables Bun's idle ceiling while `AbortSignal` still bounds
the request.

## Layout

```text
src/
  index.ts              # RuntimeClient + request/response types
  runtime-response.ts   # Shared JSON / error parsing
```
