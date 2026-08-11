import { describe, expect, it } from "vitest";
import { snapshotDir } from "./snapshot-store.js";

describe("snapshotDir", () => {
  it("defaults under TMPDIR when DEVIN_SNAPSHOT_DIR is unset", () => {
    const prev = process.env.DEVIN_SNAPSHOT_DIR;
    delete process.env.DEVIN_SNAPSHOT_DIR;
    try {
      expect(snapshotDir()).toMatch(/devin-task-snapshots$/);
    } finally {
      if (prev === undefined) {
        delete process.env.DEVIN_SNAPSHOT_DIR;
      } else {
        process.env.DEVIN_SNAPSHOT_DIR = prev;
      }
    }
  });

  it("uses DEVIN_SNAPSHOT_DIR when set", () => {
    const prev = process.env.DEVIN_SNAPSHOT_DIR;
    process.env.DEVIN_SNAPSHOT_DIR = "/var/lib/devin/task-snapshots";
    try {
      expect(snapshotDir()).toBe("/var/lib/devin/task-snapshots");
    } finally {
      if (prev === undefined) {
        delete process.env.DEVIN_SNAPSHOT_DIR;
      } else {
        process.env.DEVIN_SNAPSHOT_DIR = prev;
      }
    }
  });
});
