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
    openaiApiKeyConfigured?: boolean;
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
