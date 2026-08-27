/**
 * HydraDB client for long-lived session context (user memories + recall).
 * Disabled when HYDRADB_API_KEY and database id are unset — callers fall back
 * to Postgres event history.
 *
 * HydraDB v2 endpoints:
 * - ingest → POST /context/ingest (multipart, type=memory)
 * - recall → POST /query (JSON, type=memory)
 *
 * Scoping (HydraDB v2):
 * - database (alias tenant_id) → HYDRADB_DATABASE / HYDRADB_TENANT_ID
 * - collection (alias sub_tenant_id) → HYDRADB_COLLECTION / HYDRADB_SUB_TENANT_ID
 *   else user-<userId> (recommended), else task-<taskId>
 *
 * Memory item `metadata` MUST be a JSON-encoded string (HydraDB INVALID_INPUT
 * if passed as a nested object). `additional_metadata` stays an object.
 */

const DEFAULT_BASE_URL = "https://api.hydradb.com";
const HYDRADB_API_VERSION = "2";
const HYDRADB_TIMEOUT_MS = 15_000;
/** 30 days in seconds — matches SESSION_RETENTION_DAYS default. */
export const HYDRADB_MEMORY_TTL_SECONDS = 30 * 24 * 60 * 60;

export type HydraDbConfig = {
  apiKey: string;
  /** Top-level HydraDB database (formerly tenant_id). */
  database: string;
  baseUrl: string;
  /** Optional fixed collection; defaults to user-/task- scoped at call sites. */
  collection?: string;
};

let loggedDisabled = false;
let loggedEnabled = false;

export function resolveHydraDbConfig(): HydraDbConfig | undefined {
  const apiKey = process.env.HYDRADB_API_KEY?.trim();
  const database =
    process.env.HYDRADB_DATABASE?.trim() ||
    process.env.HYDRADB_TENANT_ID?.trim();
  if (!apiKey || !database) {
    return undefined;
  }
  return {
    apiKey,
    database,
    baseUrl: (process.env.HYDRADB_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    ),
    collection:
      process.env.HYDRADB_COLLECTION?.trim() ||
      process.env.HYDRADB_SUB_TENANT_ID?.trim() ||
      undefined,
  };
}

export function isHydraDbEnabled(): boolean {
  return resolveHydraDbConfig() !== undefined;
}

/** Log once at process start so missing wiring is obvious in Brain logs. */
export function logHydraDbStatus(prefix = "[hydradb]"): void {
  const config = resolveHydraDbConfig();
  if (!config) {
    if (!loggedDisabled) {
      loggedDisabled = true;
      console.warn(
        `${prefix} disabled — set HYDRADB_API_KEY and HYDRADB_DATABASE (or HYDRADB_TENANT_ID) on Brain`,
      );
    }
    return;
  }
  if (!loggedEnabled) {
    loggedEnabled = true;
    console.log(
      `${prefix} enabled database=${config.database} collection=${config.collection ?? "user-<id>|task-<id>"} base=${config.baseUrl}`,
    );
  }
}

export type IngestSessionMemoryInput = {
  taskId: string;
  userId?: string;
  text: string;
  title?: string;
  sourceId?: string;
  /** TTL in seconds; defaults to 30 days. */
  expirySeconds?: number;
};

export type RecallSessionMemoryInput = {
  taskId: string;
  userId?: string;
  query: string;
  topK?: number;
};

/**
 * Prefer fixed env collection, else user id (HydraDB B2C pattern), else task.
 * Per-task collections made the HydraDB Logs UI look empty when browsing a probe.
 */
export function resolveCollection(
  config: HydraDbConfig,
  taskId: string,
  userId?: string,
): string {
  if (config.collection?.trim()) {
    return config.collection.trim();
  }
  const user = userId?.trim();
  if (user) {
    return user;
  }
  return `task-${taskId}`;
}

function authHeaders(config: HydraDbConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "API-Version": HYDRADB_API_VERSION,
  };
}

async function hydraJson(
  config: HydraDbConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(config),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HYDRADB_TIMEOUT_MS),
  });
}

async function hydraMultipart(
  config: HydraDbConfig,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(config),
    body: form,
    signal: AbortSignal.timeout(HYDRADB_TIMEOUT_MS),
  });
}

type HydraEnvelope = {
  success?: boolean;
  error?: { message?: string } | string | null;
};

async function readHydraResponse(response: Response): Promise<{
  ok: boolean;
  status: number;
  payload: unknown;
  detail: string;
}> {
  const text = await response.text().catch(() => "");
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  const envelope =
    payload && typeof payload === "object"
      ? (payload as HydraEnvelope)
      : undefined;
  const errorMessage =
    typeof envelope?.error === "string"
      ? envelope.error
      : envelope?.error && typeof envelope.error === "object"
        ? String(envelope.error.message ?? "")
        : "";
  return {
    ok: response.ok && envelope?.success !== false,
    status: response.status,
    payload,
    detail: (errorMessage || text).slice(0, 240),
  };
}

export async function ingestSessionMemory(
  input: IngestSessionMemoryInput,
): Promise<boolean> {
  logHydraDbStatus();
  const config = resolveHydraDbConfig();
  if (!config) {
    return false;
  }
  const text = input.text.trim();
  if (!text) {
    return false;
  }

  const collection = resolveCollection(config, input.taskId, input.userId);
  // HydraDB v2: metadata must be a JSON *string* inside each memory item.
  const metadata = JSON.stringify({
    task_id: input.taskId,
    ...(input.userId ? { user_id: input.userId } : {}),
    product: "devin.baby",
  });
  const memories = [
    {
      id:
        input.sourceId ??
        `devin-task-${input.taskId}-${Date.now().toString(36)}`,
      title: input.title ?? `Devin session ${input.taskId.slice(0, 8)}`,
      text,
      infer: true,
      expiry_time: input.expirySeconds ?? HYDRADB_MEMORY_TTL_SECONDS,
      metadata,
      additional_metadata: {
        kind: "session_context",
        task_id: input.taskId,
        ...(input.userId ? { user_id: input.userId } : {}),
      },
    },
  ];

  try {
    const response = await hydraMultipart(config, "/context/ingest", {
      type: "memory",
      database: config.database,
      collection,
      upsert: "true",
      memories: JSON.stringify(memories),
    });
    const result = await readHydraResponse(response);
    if (!result.ok) {
      console.warn(
        `[hydradb] ingest failed HTTP ${result.status} database=${config.database} collection=${collection}: ${result.detail}`,
      );
      return false;
    }
    console.log(
      `[hydradb] ingest queued database=${config.database} collection=${collection} task=${input.taskId.slice(0, 8)}`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[hydradb] ingest error: ${message.slice(0, 240)}`);
    return false;
  }
}

type RecallChunk = {
  text?: string;
  content?: string;
  chunk?: string;
  chunk_content?: string;
};

function pushText(texts: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    texts.push(value.trim());
  }
}

function collectGraphTexts(graph: unknown, texts: string[]): void {
  if (!graph || typeof graph !== "object") {
    return;
  }
  const rows = graph as Record<string, unknown>;
  for (const key of ["query_paths", "chunk_relations"] as const) {
    const list = rows[key];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (item && typeof item === "object") {
        pushText(texts, (item as Record<string, unknown>).combined_context);
      }
    }
  }
}

function extractRecallTexts(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const root = payload as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;
  const chunks = Array.isArray(data.chunks)
    ? data.chunks
    : Array.isArray(data.results)
      ? data.results
      : Array.isArray(data.memories)
        ? data.memories
        : Array.isArray(root.chunks)
          ? root.chunks
          : Array.isArray(root.results)
            ? root.results
            : [];

  const texts: string[] = [];
  for (const item of chunks) {
    if (typeof item === "string") {
      pushText(texts, item);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as RecallChunk & Record<string, unknown>;
    pushText(
      texts,
      row.chunk_content || row.text || row.content || row.chunk || "",
    );
  }
  pushText(texts, data.additional_context);
  if (
    data.additional_context &&
    typeof data.additional_context === "object" &&
    !Array.isArray(data.additional_context)
  ) {
    for (const value of Object.values(
      data.additional_context as Record<string, unknown>,
    )) {
      pushText(texts, value);
    }
  }
  collectGraphTexts(data.graph_context, texts);
  return [...new Set(texts)];
}

/** Recall HydraDB memories for a task; returns a bounded context string or "". */
export async function recallSessionMemory(
  input: RecallSessionMemoryInput,
): Promise<string> {
  logHydraDbStatus();
  const config = resolveHydraDbConfig();
  if (!config) {
    return "";
  }
  const query = input.query.trim();
  if (!query) {
    return "";
  }

  const collection = resolveCollection(config, input.taskId, input.userId);
  try {
    const response = await hydraJson(config, "/query", {
      database: config.database,
      collection,
      query,
      type: "memory",
      query_by: "hybrid",
      mode: "fast",
      max_results: input.topK ?? 8,
    });
    const result = await readHydraResponse(response);
    if (!result.ok) {
      console.warn(
        `[hydradb] recall failed HTTP ${result.status} database=${config.database} collection=${collection}: ${result.detail}`,
      );
      return "";
    }
    const texts = extractRecallTexts(result.payload);
    if (texts.length === 0) {
      return "";
    }
    const joined = texts.join("\n- ");
    const body = `- ${joined}`;
    const max = 4_000;
    if (body.length <= max) {
      return body;
    }
    return `${body.slice(0, max)}\n[HydraDB context truncated]`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[hydradb] recall error: ${message.slice(0, 240)}`);
    return "";
  }
}

export function mergeSessionContexts(
  eventContext: string,
  hydraContext: string,
): string {
  const event = eventContext.trim();
  const hydra = hydraContext.trim();
  if (!hydra) {
    return event;
  }
  if (!event) {
    return `HydraDB session memory:\n${hydra}`;
  }
  return [
    event,
    "",
    "HydraDB session memory (long-lived preferences and prior work):",
    hydra,
  ].join("\n");
}
