export interface ServiceProbe {
  url: string;
  reachable: boolean;
  status?: string;
  error?: string;
  latencyMs?: number;
  mode?: string;
  durable?: boolean;
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

export type ServiceMode = "standalone" | "brain" | "worker";

export interface PlatformDiagnostics {
  serviceMode: ServiceMode;
  durable: boolean;
  defaultAgent: string;
  preferredHost?: string;
  executionWorker?: ServiceProbe;
}

export interface InfraDiagnostics {
  checkedAt: string;
  platform: PlatformDiagnostics;
  orchestrator: ServiceProbe;
  firecrackerHost?: ServiceProbe & FirecrackerHostStatus;
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
