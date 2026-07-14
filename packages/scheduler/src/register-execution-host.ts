import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePreferredHost } from "./preferred-host.js";

const execFileAsync = promisify(execFile);

export interface RegisterExecutionHostOptions {
  orchestratorUrl: string;
  hostName?: string;
  privateIp?: string;
  firecrackerPort?: number;
  schedulerPort?: number;
  capacityCpu?: number;
  capacityMemory?: string;
  firecrackerHostUrl?: string;
}

export async function fetchFirecrackerHostRegistration(
  orchestratorUrl: string,
  hostName: string,
): Promise<boolean> {
  const base = orchestratorUrl.trim().replace(/\/$/, "");
  if (!base || !hostName.trim()) {
    return false;
  }

  try {
    const response = await fetch(
      `${base}/internal/v1/firecracker-hosts/${encodeURIComponent(hostName)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function registerExecutionHost(
  options: RegisterExecutionHostOptions,
): Promise<void> {
  const orchestratorUrl = options.orchestratorUrl.trim().replace(/\/$/, "");
  if (!orchestratorUrl) {
    return;
  }

  const hostName =
    options.hostName?.trim() || resolvePreferredHost() || undefined;
  if (!hostName) {
    console.warn(
      "skipping firecracker host registration: SCHEDULER_HOST_NAME is unset",
    );
    return;
  }

  const privateIp =
    options.privateIp?.trim() ||
    process.env.EXECUTION_HOST_PRIVATE_IP?.trim() ||
    (await resolvePrivateIp());
  if (!privateIp) {
    console.warn(
      "skipping firecracker host registration: could not resolve execution host private IP",
    );
    return;
  }

  const firecrackerPort =
    options.firecrackerPort ?? readPort("FIRECRACKER_HOST_PORT", 9092);
  const schedulerPort =
    options.schedulerPort ?? readPort("SCHEDULER_PORT", 9091);
  const liveCapacity = await resolveHostCapacity(
    privateIp,
    firecrackerPort,
    options.firecrackerHostUrl,
  );
  const capacityCpu = options.capacityCpu ?? liveCapacity.cpu;
  const capacityMemory = options.capacityMemory?.trim() || liveCapacity.memory;

  const body = {
    spec: {
      address: `http://${privateIp}:${firecrackerPort}`,
      schedulerAddress: `http://${privateIp}:${schedulerPort}`,
      capacity: {
        cpu: capacityCpu,
        memory: capacityMemory,
      },
    },
  };

  const response = await fetch(
    `${orchestratorUrl}/internal/v1/firecracker-hosts/${encodeURIComponent(hostName)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `orchestrator rejected firecracker host registration: ${response.status} ${detail}`,
    );
  }

  console.log(
    `registered firecracker host ${hostName} at ${body.spec.address} with orchestrator`,
  );
}

export async function ensureExecutionHostRegistered(
  options: RegisterExecutionHostOptions,
): Promise<void> {
  const orchestratorUrl = options.orchestratorUrl.trim().replace(/\/$/, "");
  const hostName =
    options.hostName?.trim() || resolvePreferredHost() || undefined;
  if (!orchestratorUrl || !hostName) {
    return;
  }

  try {
    await registerExecutionHost(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Older orchestrator builds lack the host registry HTTP API. Path B hosts
    // are still provisioned via the FirecrackerHost CR applied through GitOps.
    if (/\b404\b/.test(message)) {
      console.warn(
        `orchestrator host registry API unavailable while registering ${hostName}; continuing with GitOps FirecrackerHost CR (${message})`,
      );
      return;
    }
    throw error;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await fetchFirecrackerHostRegistration(orchestratorUrl, hostName)) {
      return;
    }
    await sleep(500 * (attempt + 1));
  }

  // Visibility probe failed, but sandboxes may still schedule against the CR.
  // Prefer soft-fail over blocking every task when the registry API is missing
  // or briefly lagging behind a successful PUT.
  console.warn(
    `FirecrackerHost ${hostName} is not visible to orchestrator after registration; continuing. ` +
      "Apply infra/generated/firecracker-hosts.yaml, verify devin-firecracker namespace RBAC, " +
      "and confirm ORCHESTRATOR_URL reaches the control-plane orchestrator.",
  );
}

async function resolvePrivateIp(): Promise<string | undefined> {
  const metadataIp = await fetchEc2Metadata(
    "http://169.254.169.254/latest/meta-data/local-ipv4",
  );
  if (metadataIp) {
    return metadataIp;
  }

  try {
    const { stdout } = await execFileAsync("hostname", ["-I"]);
    const first = stdout.trim().split(/\s+/)[0];
    return first || undefined;
  } catch {
    return undefined;
  }
}

async function fetchEc2Metadata(url: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    // Prefer IMDSv2 (required when hop limit / v1 is disabled on the instance).
    let token: string | undefined;
    try {
      const tokenResponse = await fetch(
        "http://169.254.169.254/latest/api/token",
        {
          method: "PUT",
          signal: controller.signal,
          headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
        },
      );
      if (tokenResponse.ok) {
        token = (await tokenResponse.text()).trim() || undefined;
      }
    } catch {
      // Fall through to IMDSv1-style GET.
    }

    const response = await fetch(url, {
      signal: controller.signal,
      headers: token ? { "X-aws-ec2-metadata-token": token } : undefined,
    });
    if (!response.ok) {
      return undefined;
    }
    const value = (await response.text()).trim();
    return value || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveHostCapacity(
  privateIp: string,
  firecrackerPort: number,
  firecrackerHostUrl?: string,
): Promise<{ cpu: number; memory: string }> {
  const base =
    firecrackerHostUrl?.trim() ||
    process.env.FIRECRACKER_HOST_URL?.trim() ||
    `http://${privateIp}:${firecrackerPort}`;

  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/v1/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const status = (await response.json()) as {
        capacityCPU?: number;
        capacityMemory?: string;
      };
      if (status.capacityCPU && status.capacityCPU > 0) {
        return {
          cpu: status.capacityCPU,
          memory: status.capacityMemory?.trim() || "16Gi",
        };
      }
    }
  } catch {
    // fall back to env defaults
  }

  return {
    cpu: readInt("FIRECRACKER_CAPACITY_CPU", 8),
    memory: process.env.FIRECRACKER_CAPACITY_MEMORY?.trim() || "16Gi",
  };
}
