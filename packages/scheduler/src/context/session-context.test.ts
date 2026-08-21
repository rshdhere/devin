import { describe, expect, it } from "bun:test";
import { mergeSessionContexts, HYDRADB_MEMORY_TTL_SECONDS } from "./hydradb.js";
import {
  isSessionWithinRetention,
  resolveSessionRetentionMs,
  DEFAULT_SESSION_RETENTION_DAYS,
} from "./session-context.js";

describe("mergeSessionContexts", () => {
  it("returns event context when HydraDB is empty", () => {
    expect(mergeSessionContexts("event history", "")).toBe("event history");
  });

  it("returns HydraDB context when events are empty", () => {
    expect(mergeSessionContexts("", "prior preference")).toContain(
      "HydraDB session memory",
    );
    expect(mergeSessionContexts("", "prior preference")).toContain(
      "prior preference",
    );
  });

  it("merges both sources", () => {
    const merged = mergeSessionContexts(
      "Initial user request: chess",
      "board UI",
    );
    expect(merged).toContain("Initial user request: chess");
    expect(merged).toContain("HydraDB session memory");
    expect(merged).toContain("board UI");
  });
});

describe("session retention", () => {
  it("defaults to 30 days", () => {
    expect(DEFAULT_SESSION_RETENTION_DAYS).toBe(30);
    expect(resolveSessionRetentionMs()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(HYDRADB_MEMORY_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("accepts recent activity", () => {
    expect(isSessionWithinRetention(new Date().toISOString())).toBe(true);
  });

  it("rejects activity older than retention", () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    expect(isSessionWithinRetention(old)).toBe(false);
  });
});
