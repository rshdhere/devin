import { describe, expect, it } from "bun:test";
import {
  mergeSessionContexts,
  HYDRADB_MEMORY_TTL_SECONDS,
  resolveHydraDbConfig,
  isHydraDbEnabled,
} from "@scheduler/context/hydradb.js";
import {
  isSessionWithinRetention,
  resolveSessionRetentionMs,
  DEFAULT_SESSION_RETENTION_DAYS,
} from "@scheduler/context/session-context.js";

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

describe("resolveHydraDbConfig", () => {
  it("is disabled without credentials", () => {
    const prevKey = process.env.HYDRADB_API_KEY;
    const prevDb = process.env.HYDRADB_DATABASE;
    const prevTenant = process.env.HYDRADB_TENANT_ID;
    delete process.env.HYDRADB_API_KEY;
    delete process.env.HYDRADB_DATABASE;
    delete process.env.HYDRADB_TENANT_ID;
    expect(isHydraDbEnabled()).toBe(false);
    expect(resolveHydraDbConfig()).toBeUndefined();
    if (prevKey !== undefined) process.env.HYDRADB_API_KEY = prevKey;
    if (prevDb !== undefined) process.env.HYDRADB_DATABASE = prevDb;
    if (prevTenant !== undefined) process.env.HYDRADB_TENANT_ID = prevTenant;
  });

  it("accepts HYDRADB_DATABASE alias for tenant", () => {
    const prevKey = process.env.HYDRADB_API_KEY;
    const prevDb = process.env.HYDRADB_DATABASE;
    const prevTenant = process.env.HYDRADB_TENANT_ID;
    process.env.HYDRADB_API_KEY = "test-key";
    process.env.HYDRADB_DATABASE = "devin-context";
    delete process.env.HYDRADB_TENANT_ID;
    const config = resolveHydraDbConfig();
    expect(config?.database).toBe("devin-context");
    expect(isHydraDbEnabled()).toBe(true);
    if (prevKey !== undefined) process.env.HYDRADB_API_KEY = prevKey;
    else delete process.env.HYDRADB_API_KEY;
    if (prevDb !== undefined) process.env.HYDRADB_DATABASE = prevDb;
    else delete process.env.HYDRADB_DATABASE;
    if (prevTenant !== undefined) process.env.HYDRADB_TENANT_ID = prevTenant;
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
