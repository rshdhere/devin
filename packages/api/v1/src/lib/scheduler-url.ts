const DEFAULT_BRAIN_URL = "http://devin-brain:9092";
const DEFAULT_LOCAL_SCHEDULER = "http://localhost:9091";

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

/** Worker schedulers on execution hosts (brain uses these via EXECUTION_WORKER_URL). */
export function isWorkerSchedulerEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    if (port === "9091") {
      return true;
    }
    if (parsed.hostname.includes("elb.amazonaws.com")) {
      return true;
    }
    if (parsed.hostname.includes("-scheduler-")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function inClusterBrainUrl(): string | undefined {
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    return undefined;
  }

  const explicit =
    process.env.BRAIN_URL?.trim() || process.env.DEVIN_BRAIN_URL?.trim();
  if (explicit) {
    return normalizeUrl(explicit);
  }

  const host = process.env.BRAIN_SERVICE_HOST?.trim() || "devin-brain";
  const port = process.env.BRAIN_PORT?.trim() || "9092";
  const namespace = process.env.POD_NAMESPACE?.trim();
  if (namespace) {
    return `http://${host}.${namespace}.svc.cluster.local:${port}`;
  }
  return `http://${host}:${port}`;
}

/**
 * URL the API server uses for scheduler HTTP (task CRUD, events, devbox proxy).
 * In EKS this must be devin-brain (:9092), not the execution-host worker NLB (:9091).
 */
export function resolveSchedulerBaseUrl(): string {
  const configured = process.env.SCHEDULER_URL?.trim();
  const brain = inClusterBrainUrl();

  if (brain && (!configured || isWorkerSchedulerEndpoint(configured))) {
    return brain;
  }

  if (configured) {
    return normalizeUrl(configured);
  }

  return DEFAULT_LOCAL_SCHEDULER;
}

export function resolveWorkerSchedulerUrl(): string | undefined {
  const configured = process.env.SCHEDULER_URL?.trim();
  if (configured && isWorkerSchedulerEndpoint(configured)) {
    return normalizeUrl(configured);
  }
  const worker = process.env.EXECUTION_WORKER_URL?.trim();
  return worker ? normalizeUrl(worker) : undefined;
}

export { DEFAULT_BRAIN_URL, DEFAULT_LOCAL_SCHEDULER, normalizeUrl };
