export interface ServiceProbe {
  url: string;
  reachable: boolean;
  status?: string;
  error?: string;
  latencyMs?: number;
}

export interface WarmRuntimeStatus {
  runtime: string;
  readyVMs: number;
  lastWarmError?: string;
}

export interface FirecrackerHostStatus {
  host?: string;
  readyVMs?: number;
  activeVMs?: number;
  capacityCPU?: number;
  usedCPU?: number;
  defaultRuntime?: string;
  availableRuntimes?: string[];
  warmRuntimes?: WarmRuntimeStatus[];
  lastWarmError?: string;
}

export interface SandboxSummary {
  name: string;
  phase: string;
  message?: string;
  taskId?: string;
  runtime?: string;
  vmId?: string;
  host?: string;
}

export interface InfraDiagnostics {
  checkedAt: string;
  orchestrator: ServiceProbe;
  firecrackerHost?: ServiceProbe & FirecrackerHostStatus;
  agent?: {
    defaultAgent: string;
    cursorApiKeyConfigured: boolean;
    anthropicApiKeyConfigured: boolean;
  };
  sandboxes: {
    total: number;
    byPhase: Record<string, number>;
    items: SandboxSummary[];
  };
}

export interface TaskDiagnostics {
  taskId: string;
  sandboxName?: string;
  sandbox?: SandboxSummary;
}

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
    try {
      const payload = (await response.json()) as {
        status?: string;
        readyVMs?: number;
      };
      status = payload.status;
    } catch {
      status = "ok";
    }

    return { url: target, reachable: true, status, latencyMs };
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
    return "firecracker-host URL is not configured";
  }
  if (!status.reachable) {
    return status.error ?? "firecracker-host is unreachable";
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
    return `firecracker-host cannot warm ${runtime} microVMs: ${runtimeWarm.lastWarmError}`;
  }

  if (status.lastWarmError && (status.readyVMs ?? 0) === 0) {
    return status.lastWarmError;
  }

  return undefined;
}

export async function collectInfraDiagnostics(options: {
  orchestratorUrl: string;
  firecrackerHostUrl?: string;
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

  return {
    checkedAt: new Date().toISOString(),
    orchestrator: orchestratorProbe,
    firecrackerHost,
    agent: {
      defaultAgent:
        process.env.DEFAULT_AGENT?.trim() ||
        (process.env.CURSOR_API_KEY?.trim()
          ? "cursor"
          : process.env.ANTHROPIC_API_KEY?.trim()
            ? "claude"
            : "mock"),
      cursorApiKeyConfigured: Boolean(process.env.CURSOR_API_KEY?.trim()),
      anthropicApiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
      openaiApiKeyConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    },
    sandboxes: {
      total: sandboxes.length,
      byPhase,
      items: sandboxes,
    },
  };
}
