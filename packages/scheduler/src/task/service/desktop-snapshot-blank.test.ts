import { deflateSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLikelyBlankScreenshot } from "./desktop-snapshot-blank.js";
import { persistDesktopSnapshot } from "./desktop-capture-fetch.js";
import type { ReviewSession } from "./types.js";
import type { TaskService } from "./task-service.js";

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]!;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function createSolidPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Buffer {
  const stride = width * 3;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + stride);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      const i = 1 + x * 3;
      row[i] = r;
      row[i + 1] = g;
      row[i + 2] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("isLikelyBlankScreenshot", () => {
  it("detects solid white PNGs", () => {
    const white = createSolidPng(64, 48, 255, 255, 255);
    expect(isLikelyBlankScreenshot(white)).toBe(true);
  });

  it("accepts non-blank architecture screenshots", () => {
    const architecture = readFileSync(
      join(import.meta.dir, "../../../../../docs/architecture.png"),
    );
    expect(isLikelyBlankScreenshot(architecture)).toBe(false);
  });

  it("rejects tiny buffers", () => {
    expect(isLikelyBlankScreenshot(Buffer.from([1, 2, 3]))).toBe(true);
  });
});

describe("persistDesktopSnapshot", () => {
  it("does not persist blank screenshots", async () => {
    let saved = false;
    const svc = {
      mode: "worker",
      eventSequences: new Map<string, number>(),
      eventBus: { publish: () => undefined },
      taskStore: {
        isEnabled: () => false,
        appendEvent: async () => undefined,
        saveDesktopSnapshot: async () => {
          saved = true;
        },
      },
    } as unknown as TaskService;
    const session = {} as ReviewSession;
    await persistDesktopSnapshot(
      svc,
      "task-1",
      session,
      createSolidPng(32, 32, 255, 255, 255),
    );
    expect(saved).toBe(false);
    expect(session.lastDesktopScreenshot).toBeUndefined();
  });
});

describe("shouldCapturePreviewOnPortChange", () => {
  it("skips capture while the agent task is processing", async () => {
    const { shouldCapturePreviewOnPortChange } =
      await import("./desktop-capture-render.js");
    const svc = {
      processingTasks: new Set(["task-1"]),
    } as Pick<TaskService, "processingTasks">;
    expect(shouldCapturePreviewOnPortChange(svc, "task-1", true)).toBe(false);
    expect(shouldCapturePreviewOnPortChange(svc, "task-1", false)).toBe(false);
  });

  it("captures when the port changed and the agent is idle", async () => {
    const { shouldCapturePreviewOnPortChange } =
      await import("./desktop-capture-render.js");
    const svc = {
      processingTasks: new Set<string>(),
    } as Pick<TaskService, "processingTasks">;
    expect(shouldCapturePreviewOnPortChange(svc, "task-1", true)).toBe(true);
  });
});
