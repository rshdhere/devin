import { probeService } from "../diagnostics/collect.js";

const DEFAULT_ORCHESTRATOR_PORT = "9090";
const DEFAULT_ORCHESTRATOR_NAMESPACE = "devin-system";

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function isPlaceholderOrchestratorUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("pending-ssm-sync") ||
    lower.includes("replace_after_orchestrator") ||
    lower === "http://localhost:9090"
  );
}

function inClusterOrchestratorCandidates(): string[] {
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    return [];
  }

  const namespace =
    process.env.ORCHESTRATOR_NAMESPACE?.trim() ||
    DEFAULT_ORCHESTRATOR_NAMESPACE;
  const port =
    process.env.ORCHESTRATOR_PORT?.trim() || DEFAULT_ORCHESTRATOR_PORT;
  const serviceHost =
    process.env.ORCHESTRATOR_SERVICE_HOST?.trim() || "devin-orchestrator";
  const nlbHost =
    process.env.ORCHESTRATOR_NLB_SERVICE_HOST?.trim() ||
    "devin-orchestrator-lb";

  return [
    `http://${nlbHost}.${namespace}.svc.cluster.local:${port}`,
    `http://${serviceHost}.${namespace}.svc.cluster.local:${port}`,
    `http://${nlbHost}:${port}`,
    `http://${serviceHost}:${port}`,
  ];
}

export function orchestratorUrlCandidates(configured?: string): string[] {
  const candidates: string[] = [];
  const fromEnv = configured?.trim() || process.env.ORCHESTRATOR_URL?.trim();

  if (fromEnv && !isPlaceholderOrchestratorUrl(fromEnv)) {
    candidates.push(normalizeUrl(fromEnv));
  }

  for (const candidate of inClusterOrchestratorCandidates()) {
    candidates.push(candidate);
  }

  if (fromEnv && !candidates.includes(normalizeUrl(fromEnv))) {
    candidates.push(normalizeUrl(fromEnv));
  }

  if (!process.env.KUBERNETES_SERVICE_HOST) {
    candidates.push("http://localhost:9090");
  }

  return [...new Set(candidates)];
}

/** Pick the first reachable orchestrator URL from env + in-cluster defaults. */
export async function resolveOrchestratorUrl(
  configured?: string,
): Promise<string> {
  const candidates = orchestratorUrlCandidates(configured);
  for (const url of candidates) {
    const probe = await probeService(url);
    if (probe.reachable) {
      return normalizeUrl(url);
    }
  }
  return candidates[0] ?? "http://localhost:9090";
}

export function formatOrchestratorConnectionError(
  orchestratorUrl: string,
  error: unknown,
): string {
  const detail =
    error instanceof Error ? error.message : "orchestrator request failed";
  if (/unable to connect|computer able to access/i.test(detail)) {
    return `Cannot reach orchestrator at ${orchestratorUrl}. In EKS set ORCHESTRATOR_URL to http://devin-orchestrator-lb.devin-system.svc:9090 (or run devin-infra sync-platform-config on execution hosts).`;
  }
  return `Cannot reach orchestrator at ${orchestratorUrl}: ${detail}`;
}
