import { describe, expect, it } from "vitest";
import {
  COMMON_DEVBOX_PORTS,
  buildDiscoverDevboxPortScript,
  buildStartDevServerForSnapshotScript,
  buildWaitForDevServerScript,
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
});

describe("buildWaitForDevServerScript", () => {
  it("waits on health endpoints across common ports", () => {
    const script = buildWaitForDevServerScript();
    expect(script).toContain("/health");
    expect(script).toContain("/api/health");
    expect(script).toContain("3002");
  });
});
