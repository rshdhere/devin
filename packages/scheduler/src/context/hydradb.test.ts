import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  ingestSessionMemory,
  recallSessionMemory,
  resolveCollection,
  resolveHydraDbConfig,
} from "./hydradb.js";

const ENV_KEYS = [
  "HYDRADB_API_KEY",
  "HYDRADB_DATABASE",
  "HYDRADB_TENANT_ID",
  "HYDRADB_BASE_URL",
  "HYDRADB_COLLECTION",
  "HYDRADB_SUB_TENANT_ID",
] as const;

const originalFetch = globalThis.fetch;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function enableHydraEnv(): void {
  process.env.HYDRADB_API_KEY = "test-key";
  process.env.HYDRADB_DATABASE = "devin-context";
  process.env.HYDRADB_BASE_URL = "https://api.hydradb.com";
  delete process.env.HYDRADB_TENANT_ID;
  delete process.env.HYDRADB_COLLECTION;
  delete process.env.HYDRADB_SUB_TENANT_ID;
}

describe("HydraDB v2 client", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      const previous = savedEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("scopes collection to user when env collection is unset", () => {
    enableHydraEnv();
    const config = resolveHydraDbConfig()!;
    expect(resolveCollection(config, "task-1", "user-abc")).toBe("user-abc");
    expect(resolveCollection(config, "task-1")).toBe("task-task-1");
    process.env.HYDRADB_COLLECTION = "probe-fixed";
    expect(resolveCollection(resolveHydraDbConfig()!, "task-1", "u")).toBe(
      "probe-fixed",
    );
  });

  it("skips ingest when credentials are missing", async () => {
    delete process.env.HYDRADB_API_KEY;
    delete process.env.HYDRADB_DATABASE;
    delete process.env.HYDRADB_TENANT_ID;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return jsonResponse({});
    }) as typeof fetch;

    expect(
      await ingestSessionMemory({
        taskId: "task-1",
        text: "prefers TypeScript",
      }),
    ).toBe(false);
    expect(called).toBe(0);
  });

  it("ingests memories via multipart POST /context/ingest", async () => {
    enableHydraEnv();
    let url = "";
    let init: RequestInit | undefined;
    globalThis.fetch = (async (input, nextInit) => {
      url = String(input);
      init = nextInit;
      return jsonResponse({ success: true, data: { queued: true } }, 202);
    }) as typeof fetch;

    const ok = await ingestSessionMemory({
      taskId: "task-abc12345",
      userId: "user-1",
      text: "Prefers TypeScript and Next.js.",
      title: "Brain memory task-abc",
      sourceId: "devin-task-task-abc12345-snapshot",
    });

    expect(ok).toBe(true);
    expect(url).toBe("https://api.hydradb.com/context/ingest");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "API-Version": "2",
    });
    expect(
      (init?.headers as Record<string, string>)["Content-Type"],
    ).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);

    const form = init?.body as FormData;
    expect(form.get("type")).toBe("memory");
    expect(form.get("database")).toBe("devin-context");
    expect(form.get("collection")).toBe("user-1");
    expect(form.get("upsert")).toBe("true");
    const memories = JSON.parse(String(form.get("memories"))) as Array<{
      id: string;
      text: string;
      infer: boolean;
      metadata: string;
      additional_metadata: { kind: string; task_id: string; user_id: string };
    }>;
    expect(memories).toHaveLength(1);
    expect(memories[0]?.id).toBe("devin-task-task-abc12345-snapshot");
    expect(memories[0]?.text).toBe("Prefers TypeScript and Next.js.");
    expect(memories[0]?.infer).toBe(true);
    expect(JSON.parse(memories[0]!.metadata)).toEqual({
      task_id: "task-abc12345",
      user_id: "user-1",
      product: "devin.baby",
    });
    expect(memories[0]?.additional_metadata).toEqual({
      kind: "session_context",
      task_id: "task-abc12345",
      user_id: "user-1",
    });
  });

  it("treats ingest success:false as failure", async () => {
    enableHydraEnv();
    globalThis.fetch = (async () =>
      jsonResponse(
        {
          success: false,
          error: { code: "INVALID_INPUT", message: "bad memories field" },
        },
        200,
      )) as typeof fetch;

    expect(
      await ingestSessionMemory({
        taskId: "task-1",
        text: "prefers dark mode",
      }),
    ).toBe(false);
  });

  it("recalls memories via POST /query type=memory", async () => {
    enableHydraEnv();
    let url = "";
    let init: RequestInit | undefined;
    globalThis.fetch = (async (input, nextInit) => {
      url = String(input);
      init = nextInit;
      return jsonResponse({
        success: true,
        data: {
          chunks: [
            {
              chunk_content: "Prefers TypeScript and Next.js",
              source_title: "Brain memory",
            },
          ],
          graph_context: {
            query_paths: [{ combined_context: "User ships games in Next.js" }],
          },
        },
      });
    }) as typeof fetch;

    const recalled = await recallSessionMemory({
      taskId: "task-abc12345",
      userId: "user-1",
      query: "What stack does the user prefer?",
      topK: 5,
    });

    expect(url).toBe("https://api.hydradb.com/query");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "API-Version": "2",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      database: "devin-context",
      collection: "user-1",
      query: "What stack does the user prefer?",
      type: "memory",
      query_by: "hybrid",
      mode: "fast",
      max_results: 5,
    });
    expect(recalled).toContain("Prefers TypeScript and Next.js");
    expect(recalled).toContain("User ships games in Next.js");
  });
});
