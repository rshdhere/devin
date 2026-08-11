import { describe, expect, it } from "vitest";
import {
  COMMON_DEVBOX_PORTS,
  RUNTIME_SUPERVISOR_PORTS,
  buildDiscoverDevboxPortScript,
  buildStartDevServerForSnapshotScript,
  buildWaitForDevServerScript,
  buildDesktopScreenshotScript,
} from "./preview.js";

describe("buildDiscoverDevboxPortScript", () => {
  it("discovers any listening port via ss, not only a fixed list", () => {
    const script = buildDiscoverDevboxPortScript();
    expect(script).toContain("ss -ltnH");
    expect(script).toContain("/api/health");
    expect(script).toContain("3002");
  });

  it("includes common fallback ports", () => {
    const script = buildDiscoverDevboxPortScript();
    for (const port of COMMON_DEVBOX_PORTS.slice(0, 4)) {
      expect(script).toContain(String(port));
    }
  });

  it("skips the runtime supervisor port so 8081/health is not the app", () => {
    const script = buildDiscoverDevboxPortScript();
    for (const port of RUNTIME_SUPERVISOR_PORTS) {
      expect(script).toContain(String(port));
    }
    expect(script).toContain("is_skipped");
    expect(script).toContain("Prefer /");
  });

  it("prefers COMMON app ports before arbitrary ss listeners", () => {
    const script = buildDiscoverDevboxPortScript();
    const commonIdx = script.indexOf("for p in $COMMON $LISTEN");
    expect(commonIdx).toBeGreaterThan(-1);
  });
});

describe("buildStartDevServerForSnapshotScript", () => {
  it("starts npm dev servers from package.json", () => {
    const script = buildStartDevServerForSnapshotScript();
    expect(script).toContain("npm run dev");
    expect(script).toContain("npm start");
  });

  it("falls back to tsx/node entrypoints for socket.io-style apps", () => {
    const script = buildStartDevServerForSnapshotScript();
    expect(script).toContain("tsx src/index.ts");
    expect(script).toContain("node dist/index.js");
    expect(script).toContain("PORT=3000");
  });

  it("starts FastAPI via uvicorn when main.py exists", () => {
    const script = buildStartDevServerForSnapshotScript();
    expect(script).toContain("uvicorn main:app");
    expect(script).toContain("uvicorn app:app");
  });

  it("builds a reusable Go binary instead of cold go run", () => {
    const script = buildStartDevServerForSnapshotScript();
    expect(script).toContain("go.mod");
    expect(script).toContain("main.go");
    expect(script).toContain("go build -o");
    expect(script).toContain("/workspace/.home/devin-app");
  });
});

describe("buildWaitForDevServerScript", () => {
  it("waits on health endpoints across common ports", () => {
    const script = buildWaitForDevServerScript();
    expect(script).toContain("/health");
    expect(script).toContain("/api/health");
    expect(script).toContain("3002");
  });

  it("waits long enough for cold Go builds", () => {
    const script = buildWaitForDevServerScript();
    expect(script).toContain("seq 1 90");
    expect(script).toContain("is_skipped");
  });
});

describe("buildDesktopScreenshotScript", () => {
  it("passes disable-dev-shm-usage for Firecracker guests", () => {
    const script = buildDesktopScreenshotScript(
      "http://127.0.0.1:3000/",
      "/workspace/.home/desktop-preview.png",
    );
    expect(script).toContain("--disable-dev-shm-usage");
  });
});
