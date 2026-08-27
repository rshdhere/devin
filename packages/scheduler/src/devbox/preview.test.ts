import { describe, expect, it } from "vitest";
import {
  COMMON_DEVBOX_PORTS,
  DEVIN_SNAPSHOT_SERVER_PORT,
  RUNTIME_SUPERVISOR_PORTS,
  buildDiscoverDevboxPortScript,
  buildDiscoverPreviewPathScript,
  buildSnapshotSmokeStartScript,
  buildStartDevServerForSnapshotScript,
  buildWaitForDevServerScript,
  buildDesktopScreenshotScript,
  buildPruneWorkspaceDiskScript,
  isUnusablePreviewHttpStatus,
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
    expect(script).toContain(`PORT=${DEVIN_SNAPSHOT_SERVER_PORT}`);
  });

  it("rewrites hardcoded next start port 3000 for platform preview server", () => {
    const script = buildStartDevServerForSnapshotScript();
    expect(script).toContain(
      `DEVIN_PREVIEW_PORT=${DEVIN_SNAPSHOT_SERVER_PORT}`,
    );
    expect(script).toContain("--port[[:space:]]+3000/--port 3099");
    expect(COMMON_DEVBOX_PORTS).toContain(DEVIN_SNAPSHOT_SERVER_PORT);
  });

  it("uses the platform preview port in smoke start script", () => {
    const script = buildSnapshotSmokeStartScript();
    expect(script).toContain(`PORT=${DEVIN_SNAPSHOT_SERVER_PORT}`);
  });

  it("starts FastAPI via uvicorn when main.py exists", () => {
    const script = buildStartDevServerForSnapshotScript();
    expect(script).toContain("uvicorn main:app");
    expect(script).toContain("uvicorn app:app");
  });

  it("prefers bun for Node package.json projects when available", () => {
    const script = buildStartDevServerForSnapshotScript();
    expect(script).toContain("bun run dev");
    expect(script).toContain("bun run start");
  });

  it("prefers Next.js over stray go.mod scaffolds", () => {
    const script = buildStartDevServerForSnapshotScript();
    expect(script).toContain("HAS_NEXT");
    expect(script).toContain('"next"');
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

describe("buildDiscoverPreviewPathScript", () => {
  it("prefers HTML UI paths and rejects mux-style 404 bodies", () => {
    const script = buildDiscoverPreviewPathScript(3000);
    expect(script).toContain("P=3000");
    expect(script).toContain("404 page not found");
    expect(script).toContain("/index.html");
    expect(script).toContain("/health");
    expect(isUnusablePreviewHttpStatus(404)).toBe(true);
    expect(isUnusablePreviewHttpStatus(200)).toBe(false);
  });
});

describe("buildPruneWorkspaceDiskScript", () => {
  it("prunes pip and npm caches when tmpfs is at least 80% full", () => {
    const script = buildPruneWorkspaceDiskScript();
    expect(script).toContain("remount,size=12G");
    expect(script).toContain("CARGO_HOME=/workspace/.build/cargo-home");
    expect(script).toContain("RUSTUP_HOME=/usr/local/rustup");
    expect(script).toContain('"$pct" -ge 80');
    expect(script).toContain(".cache/pip");
    expect(script).toContain("npm-cache");
    expect(script).toContain("__pycache__");
  });
});
