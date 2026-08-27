import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const resolveLiveSession = vi.fn();
const wakeSession = vi.fn();
const ensureDevboxAppForPreview = vi.fn();
const emit = vi.fn();

vi.mock("./desktop-capture-render.js", () => ({
  resolveLiveSession: (...args: unknown[]) => resolveLiveSession(...args),
  ensureDevboxAppForPreview: (...args: unknown[]) =>
    ensureDevboxAppForPreview(...args),
}));

vi.mock("./session-lifecycle.js", () => ({
  wakeSession: (...args: unknown[]) => wakeSession(...args),
}));

vi.mock("./task-state.js", () => ({
  emit: (...args: unknown[]) => emit(...args),
}));

vi.mock("./resolve-session-proxy.js", () => ({
  brainDelegateOrRuntime: vi.fn(),
  requestWorkerRehydrate: vi.fn(),
}));

import { ensureDesktopComputer } from "./desktop-computer.js";
import type { ReviewSession } from "./types.js";
import type { TaskService } from "./task-service.js";

describe("ensureDesktopComputer", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resolveLiveSession.mockReset();
    wakeSession.mockReset();
    ensureDevboxAppForPreview.mockReset();
    emit.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("starts the preview app and navigates after VNC ensure succeeds", async () => {
    const session = {
      runtimeBaseUrl: "http://192.168.127.8:8081",
      repoCwd: "repo",
      taskStore: undefined,
    } as unknown as ReviewSession;
    resolveLiveSession.mockResolvedValue(session);
    ensureDevboxAppForPreview.mockResolvedValue(3099);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
      headers: new Headers({ "content-type": "application/json" }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const touchSession = vi.fn().mockResolvedValue(undefined);
    const svc = {
      mode: "worker",
      taskStore: { touchSession },
    } as unknown as TaskService;

    const response = await ensureDesktopComputer(svc, "task-1");

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.127.8:8081/desktop/ensure",
      { method: "POST" },
    );
    expect(ensureDevboxAppForPreview).toHaveBeenCalledWith(
      svc,
      session,
      "task-1",
    );
    expect(emit).toHaveBeenCalledWith(
      svc,
      "agent.log",
      "task-1",
      "Interactive desktop app ready",
      expect.objectContaining({
        desktop: true,
        interactive: true,
        previewPort: 3099,
      }),
    );
  });

  it("skips preview ensure when VNC ensure fails", async () => {
    const session = {
      runtimeBaseUrl: "http://192.168.127.8:8081",
      repoCwd: "repo",
    } as ReviewSession;
    resolveLiveSession.mockResolvedValue(session);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "desktop down",
      headers: new Headers(),
    }) as typeof fetch;

    const svc = {
      mode: "worker",
      taskStore: { touchSession: vi.fn() },
    } as unknown as TaskService;

    const response = await ensureDesktopComputer(svc, "task-1");

    expect(response.status).toBe(503);
    expect(ensureDevboxAppForPreview).not.toHaveBeenCalled();
  });
});
