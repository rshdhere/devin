import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./task-state.js", () => ({
  emit: vi.fn(),
}));

vi.mock("./resolve-session-proxy.js", () => ({
  resolveRuntimeSession: vi.fn(),
}));

import { navigateDesktopBrowserToPort } from "./desktop-navigate.js";
import type { ReviewSession } from "./types.js";
import type { TaskService } from "./task-service.js";

describe("navigateDesktopBrowserToPort", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("posts the preview URL to the runtime navigate endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock as typeof fetch;

    const session = {
      runtimeBaseUrl: "http://192.168.127.8:8081",
    } as ReviewSession;
    const svc = {} as TaskService;

    const done = navigateDesktopBrowserToPort(svc, session, "task-1", 3000);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.127.8:8081/desktop/navigate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "http://127.0.0.1:3000/" }),
      }),
    );
  });

  it("retries when navigate fails then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true });
    globalThis.fetch = fetchMock as typeof fetch;

    const session = {
      runtimeBaseUrl: "http://192.168.127.8:8081",
    } as ReviewSession;
    const svc = {} as TaskService;

    const done = navigateDesktopBrowserToPort(svc, session, "task-1", 4173);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
