import type {
  FirecrackerHostStatus,
  InfraDiagnostics,
  SandboxSummary,
  ServiceMode,
  ServiceProbe,
  TaskDiagnostics,
} from "@devin/types";
import { resolveDefaultAgent } from "./agent-defaults.js";
import { resolvePreferredHost } from "./preferred-host.js";

export type {
  FirecrackerHostStatus,
  InfraDiagnostics,
  SandboxSummary,
  ServiceProbe,
  TaskDiagnostics,
} from "@devin/types";

type SandboxRecord = {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { taskId?: string; runtime?: string };
  status?: {
    phase?: string;
    message?: string;
    vmId?: string;
    host?: string;
    runtimeURL?: string;
  };
};

export async function probeService(
  url: string,
  path = "/health",
): Promise<ServiceProbe> {
  const target = `${url.replace(/\/$/, "")}${path}`;
  const started = Date.now();
  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(5_000),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        url: target,
        reachable: false,
        error: `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        latencyMs,
      };
    }

    let status: string | undefined;
    let mode: string | undefined;
    let durable: boolean | undefined;
    try {
      const payload = (await response.json()) as {
        status?: string;
        mode?: string;
        durable?: boolean;
        readyVMs?: number;
      };
      status = payload.status;
      mode = payload.mode;
      durable = payload.durable;
    } catch {
      status = "ok";
    }

    return { url: target, reachable: true, status, latencyMs, mode, durable };
  } catch (error) {
    return {
      url: target,
      reachable: false,
      error: error instanceof Error ? error.message : "probe failed",
      latencyMs: Date.now() - started,
    };
  }
}

export async function fetchFirecrackerHostStatus(
  baseUrl: string,
): Promise<(ServiceProbe & FirecrackerHostStatus) | undefined> {
  const health = await probeService(baseUrl, "/health");
  if (!health.reachable) {
    return health;
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        ...health,
        error: `status HTTP ${response.status}`,
      };
    }

    const status = (await response.json()) as FirecrackerHostStatus;
    return {
      ...health,
      ...status,
    };
  } catch (error) {
    return {
      ...health,
      error: error instanceof Error ? error.message : "status probe failed",
    };
  }
}

export async function listSandboxes(
  orchestratorUrl: string,
): Promise<SandboxSummary[]> {
  try {
    const response = await fetch(
      `${orchestratorUrl.replace(/\/$/, "")}/internal/v1/sandboxes`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) {
      return [];
    }

    const items = (await response.json()) as SandboxRecord[];
    if (!Array.isArray(items)) {
      return [];
    }

    return items.map((item) => ({
      name: item.metadata?.name ?? "unknown",
      phase: item.status?.phase ?? "Unknown",
      message: item.status?.message,
      taskId:
        item.spec?.taskId ?? item.metadata?.labels?.["devin.baby/task-id"],
      runtime: item.spec?.runtime,
      vmId: item.status?.vmId,
      host: item.status?.host,
    }));
  } catch {
    return [];
  }
}

export async function fetchSandboxByName(
  orchestratorUrl: string,
  sandboxName: string,
): Promise<SandboxSummary | undefined> {
  try {
    const response = await fetch(
      `${orchestratorUrl.replace(/\/$/, "")}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) {
      return undefined;
    }

    const item = (await response.json()) as SandboxRecord;
    return {
      name: item.metadata?.name ?? sandboxName,
      phase: item.status?.phase ?? "Unknown",
      message: item.status?.message,
      taskId:
        item.spec?.taskId ?? item.metadata?.labels?.["devin.baby/task-id"],
      runtime: item.spec?.runtime,
      vmId: item.status?.vmId,
      host: item.status?.host,
    };
  } catch {
    return undefined;
  }
}

export async function validateFirecrackerHostForRuntime(
  baseUrl: string,
  runtime: string,
): Promise<string | undefined> {
  const status = await fetchFirecrackerHostStatus(baseUrl);
  if (!status) {
    return "firecracker URL is not configured";
  }
  if (!status.reachable) {
    return status.error ?? "firecracker is unreachable";
  }

  if (status.availableRuntimes && status.availableRuntimes.length === 0) {
    return "no Firecracker snapshots are installed on this execution host";
  }

  if (
    status.availableRuntimes &&
    status.availableRuntimes.length > 0 &&
    !status.availableRuntimes.includes(runtime)
  ) {
    return `runtime ${runtime} snapshots are not installed on this host (available: ${status.availableRuntimes.join(", ")})`;
  }

  const runtimeWarm = status.warmRuntimes?.find(
    (entry) => entry.runtime === runtime,
  );
  if (runtimeWarm?.lastWarmError) {
    return `firecracker cannot warm ${runtime} microVMs: ${runtimeWarm.lastWarmError}`;
  }

  if (status.lastWarmError && (status.readyVMs ?? 0) === 0) {
    return status.lastWarmError;
  }

  return undefined;
}

export async function collectInfraDiagnostics(options: {
  orchestratorUrl: string;
  firecrackerHostUrl?: string;
  mode?: ServiceMode;
  executionWorkerUrl?: string;
  durable?: boolean;
}): Promise<InfraDiagnostics> {
  const orchestratorProbe = await probeService(options.orchestratorUrl);
  const sandboxes = orchestratorProbe.reachable
    ? await listSandboxes(options.orchestratorUrl)
    : [];

  const byPhase: Record<string, number> = {};
  for (const sandbox of sandboxes) {
    byPhase[sandbox.phase] = (byPhase[sandbox.phase] ?? 0) + 1;
  }

  let firecrackerHost: (ServiceProbe & FirecrackerHostStatus) | undefined;
  if (options.firecrackerHostUrl?.trim()) {
    firecrackerHost = await fetchFirecrackerHostStatus(
      options.firecrackerHostUrl.trim(),
    );
  }

  const serviceMode = options.mode ?? "standalone";
  const preferredHost = resolvePreferredHost();
  let executionWorker: ServiceProbe | undefined;
  if (options.executionWorkerUrl?.trim()) {
    executionWorker = await probeService(options.executionWorkerUrl.trim());
  }

  return {
    checkedAt: new Date().toISOString(),
    platform: {
      serviceMode,
      durable: options.durable ?? false,
      defaultAgent: resolveDefaultAgent(),
      preferredHost: preferredHost || undefined,
      executionWorker,
    },
    orchestrator: orchestratorProbe,
    firecrackerHost,
    sandboxes: {
      total: sandboxes.length,
      byPhase,
      items: sandboxes,
    },
  };
}
