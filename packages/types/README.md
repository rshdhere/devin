# `@devin/types`

Shared TypeScript types and helpers used across the API, scheduler, and web app.

## Exports

| Area | Contents |
| ---- | -------- |
| Agents | `AgentProvider`, `usesRuntimeAgent`, `isTemplateAgent` |
| Tasks | `Task`, `TaskStatus`, `CreateTaskRequest`, `GitHubPermissions` |
| Events | `TaskEvent`, `TaskEventType` |
| Diagnostics | Infra / task / sandbox probe types |
| Runtime | `SANDBOX_RUNTIMES`, stack inference, `resolveRuntimeForTask` |

```ts
import {
  resolveRuntimeForTask,
  type Task,
  type AgentProvider,
} from "@devin/types";
```

## Layout

```text
src/
  index.ts         # Public barrel
  agents.ts
  tasks.ts
  events.ts
  diagnostics.ts
  runtime.ts
  runtime.test.ts
```
