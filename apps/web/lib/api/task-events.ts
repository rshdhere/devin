import type { TaskEvent } from "@devin/types";
import { tasksApiUrl } from "./http";

function isTransientStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /Error in input stream/i.test(message) ||
    /network error/i.test(message) ||
    /Failed to fetch/i.test(message) ||
    /Load failed/i.test(message) ||
    /The operation was aborted/i.test(message)
  );
}

export function subscribeToTaskEvents(
  taskId: string,
  onEvent: (event: TaskEvent) => void,
  onError?: (error: Error) => void,
  options?: { reconnect?: boolean },
): () => void {
  const controller = new AbortController();
  let reconnectAttempts = 0;
  let shouldReconnect = options?.reconnect ?? true;
  const seenEventIds = new Set<string>();
  // Long cursor runs routinely exceed proxy idle limits; keep retrying.
  const maxReconnectAttempts = 40;

  const connect = async () => {
    while (!controller.signal.aborted && shouldReconnect) {
      try {
        const response = await fetch(
          tasksApiUrl(`/${encodeURIComponent(taskId)}/events`),
          {
            credentials: "include",
            signal: controller.signal,
          },
        );

        if (!response.ok || !response.body) {
          throw new Error("Failed to connect to event stream");
        }

        reconnectAttempts = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let splitIndex = buffer.indexOf("\n\n");

          while (splitIndex >= 0) {
            const chunk = buffer.slice(0, splitIndex);
            buffer = buffer.slice(splitIndex + 2);

            if (chunk.startsWith(":")) {
              splitIndex = buffer.indexOf("\n\n");
              continue;
            }

            const dataLine = chunk
              .split("\n")
              .find((line) => line.startsWith("data: "));

            if (dataLine) {
              try {
                const event = JSON.parse(dataLine.slice(6)) as TaskEvent;
                if (!seenEventIds.has(event.id)) {
                  seenEventIds.add(event.id);
                  onEvent(event);
                  if (event.type === "task.failed") {
                    shouldReconnect = false;
                  }
                }
              } catch {
                // ignore malformed events
              }
            }

            splitIndex = buffer.indexOf("\n\n");
          }
        }

        if (!shouldReconnect || controller.signal.aborted) {
          return;
        }
        // Clean EOF mid-run (proxy idle close) — reconnect without counting as hard error.
        reconnectAttempts = 0;
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        reconnectAttempts += 1;
        const transient = isTransientStreamError(error);
        if (
          !shouldReconnect ||
          (!transient && reconnectAttempts > 8) ||
          (transient && reconnectAttempts > maxReconnectAttempts)
        ) {
          onError?.(
            error instanceof Error ? error : new Error("Event stream error"),
          );
          return;
        }

        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(1000 * Math.min(reconnectAttempts, 8), 8000),
          ),
        );
      }
    }
  };

  void connect();

  return () => controller.abort();
}
