/**
 * HydraDB client for long-lived session context (user memories + recall).
 * Disabled when HYDRADB_API_KEY / HYDRADB_TENANT_ID are unset — callers fall back
 * to Postgres event history.
 */

const DEFAULT_BASE_URL = "https://api.hydradb.com";
/** 30 days in seconds — matches SESSION_RETENTION_DAYS default. */
export const HYDRADB_MEMORY_TTL_SECONDS = 30 * 24 * 60 * 60;

export type HydraDbConfig = {
  apiKey: string;
  tenantId: string;
  baseUrl: string;
  /** Optional sub-tenant; defaults to taskId at call sites. */
  subTenantId?: string;
};

export function resolveHydraDbConfig(): HydraDbConfig | undefined {
  const apiKey = process.env.HYDRADB_API_KEY?.trim();
  const tenantId = process.env.HYDRADB_TENANT_ID?.trim();
  if (!apiKey || !tenantId) {
    return undefined;
  }
  return {
    apiKey,
    tenantId,
    baseUrl: (process.env.HYDRADB_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    ),
    subTenantId: process.env.HYDRADB_SUB_TENANT_ID?.trim() || undefined,
  };
}

export function isHydraDbEnabled(): boolean {
  return resolveHydraDbConfig() !== undefined;
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
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

export async function ingestSessionMemory(
  input: IngestSessionMemoryInput,
): Promise<boolean> {
  const config = resolveHydraDbConfig();
  if (!config) {
    return false;
  }
  const text = input.text.trim();
  if (!text) {
    return false;
  }

  try {
    const response = await hydraFetch(config, "/memories/add_memory", {
      tenant_id: config.tenantId,
      sub_tenant_id: config.subTenantId || input.taskId,
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
          },
        },
      ],
    });
    return response.ok;
  } catch {
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
  const chunks = Array.isArray(root.chunks)
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
  const config = resolveHydraDbConfig();
  if (!config) {
    return "";
  }
  const query = input.query.trim();
  if (!query) {
    return "";
  }

  try {
    const response = await hydraFetch(config, "/recall/recall_preferences", {
      tenant_id: config.tenantId,
      sub_tenant_id: config.subTenantId || input.taskId,
      query,
      top_k: input.topK ?? 8,
      alpha: 0.7,
      graph_context: true,
      metadata_filters: {
        task_id: input.taskId,
      },
    });
    if (!response.ok) {
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
  } catch {
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
