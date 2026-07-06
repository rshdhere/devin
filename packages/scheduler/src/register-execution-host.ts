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
  const capacityCpu =
    options.capacityCpu ?? readInt("FIRECRACKER_CAPACITY_CPU", 8);
  const capacityMemory =
    options.capacityMemory?.trim() ||
    process.env.FIRECRACKER_CAPACITY_MEMORY?.trim() ||
    "16Gi";

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
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
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
