/**
 * HydraDB client for long-lived session context (user memories + recall).
 * Disabled when HYDRADB_API_KEY and database id are unset — callers fall back
 * to Postgres event history.
 *
 * Scoping (HydraDB v2):
 * - database (alias tenant_id) → HYDRADB_DATABASE / HYDRADB_TENANT_ID
 * - collection (alias sub_tenant_id) → HYDRADB_COLLECTION / HYDRADB_SUB_TENANT_ID
 *   or per-task id when unset (one collection per Devin session)
 */

const DEFAULT_BASE_URL = "https://api.hydradb.com";
/** 30 days in seconds — matches SESSION_RETENTION_DAYS default. */
export const HYDRADB_MEMORY_TTL_SECONDS = 30 * 24 * 60 * 60;

export type HydraDbConfig = {
  apiKey: string;
  /** Top-level HydraDB database (formerly tenant_id). */
  database: string;
  baseUrl: string;
  /** Optional fixed collection; defaults to taskId at call sites. */
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
      `${prefix} enabled database=${config.database} collection=${config.collection ?? "<taskId>"} base=${config.baseUrl}`,
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

function resolveCollection(config: HydraDbConfig, taskId: string): string {
  return config.collection?.trim() || taskId;
}

async function hydraFetch(
  config: HydraDbConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "API-Version": "2",
    },
    body: JSON.stringify(body),
    // Ingest/recall can be slow on cold collections.
    signal: AbortSignal.timeout(15_000),
  });
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

  const collection = resolveCollection(config, input.taskId);
  try {
    const response = await hydraFetch(config, "/memories/add_memory", {
      // v2 + legacy aliases so either middleware path works.
      database: config.database,
      tenant_id: config.database,
      collection,
      sub_tenant_id: collection,
      upsert: true,
      memories: [
        {
          source_id:
            input.sourceId ??
            `devin-task-${input.taskId}-${Date.now().toString(36)}`,
          title: input.title ?? `Devin session ${input.taskId.slice(0, 8)}`,
          text,
          infer: true,
          expiry_time: input.expirySeconds ?? HYDRADB_MEMORY_TTL_SECONDS,
          metadata: {
            task_id: input.taskId,
            ...(input.userId ? { user_id: input.userId } : {}),
            product: "devin.baby",
          },
          additional_metadata: {
            kind: "session_context",
            task_id: input.taskId,
            ...(input.userId ? { user_id: input.userId } : {}),
          },
        },
      ],
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 240);
      console.warn(
        `[hydradb] ingest failed HTTP ${response.status} database=${config.database} collection=${collection}: ${detail}`,
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
};

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
    if (typeof item === "string" && item.trim()) {
      texts.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as RecallChunk & Record<string, unknown>;
    const candidate =
      (typeof row.text === "string" && row.text) ||
      (typeof row.content === "string" && row.content) ||
      (typeof row.chunk === "string" && row.chunk) ||
      "";
    if (candidate.trim()) {
      texts.push(candidate.trim());
    }
  }
  return texts;
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

  const collection = resolveCollection(config, input.taskId);
  try {
    const response = await hydraFetch(config, "/recall/recall_preferences", {
      database: config.database,
      tenant_id: config.database,
      collection,
      sub_tenant_id: collection,
      query,
      top_k: input.topK ?? 8,
      alpha: 0.7,
      graph_context: true,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 240);
      console.warn(
        `[hydradb] recall failed HTTP ${response.status} database=${config.database} collection=${collection}: ${detail}`,
      );
      return "";
    }
    const texts = extractRecallTexts(await response.json());
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
