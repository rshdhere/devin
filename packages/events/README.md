# `@devin/events`

In-process event bus and SSE formatting for task activity streams.

The scheduler publishes lifecycle events (`sandbox.provisioning`, `agent.log`,
`task.completed`, …). The API streams them to the web UI via Server-Sent Events.

## Usage

```ts
import { EventBus, formatSSE, type TaskEvent } from "@devin/events";

const bus = new EventBus();
bus.subscribe(taskId, (event) => {
  res.write(formatSSE(event));
});
bus.publish({
  id: crypto.randomUUID(),
  taskId,
  type: "agent.log",
  message: "Booting sandbox",
  timestamp: new Date().toISOString(),
});
```

## API

| Symbol | Purpose |
| ------ | ------- |
| `EventBus` | Per-task publish / subscribe with in-memory history |
| `formatSSE` | Encode a `TaskEvent` as an SSE frame |
| `TaskEvent` / `TaskEventType` | Event payload and discriminated type union |

History is process-local (not durable across restarts). Durable task/event
persistence lives in `@devin/drizzle` via the scheduler's `TaskStore`.
