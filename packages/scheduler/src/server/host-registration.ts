import { ensureExecutionHostRegistered } from "../host/register-execution-host.js";
import { resolvePreferredHost } from "../host/preferred-host.js";

export function resolvePinnedHost(): string | undefined {
  const preferredHost = resolvePreferredHost();
  if (preferredHost) {
    console.log(`service pinned to execution host ${preferredHost}`);
  }
  return preferredHost;
}

export async function registerExecutionHostOnce(options: {
  orchestratorUrl: string;
  hostName?: string;
  firecrackerHostUrl?: string;
}): Promise<void> {
  try {
    await ensureExecutionHostRegistered({
      orchestratorUrl: options.orchestratorUrl,
      hostName: options.hostName,
      firecrackerHostUrl: options.firecrackerHostUrl,
    });
  } catch (error) {
    console.error(
      "firecracker host registration failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export function startExecutionHostReRegistration(options: {
  orchestratorUrl: string;
  hostName: string;
  firecrackerHostUrl?: string;
  intervalMs?: number;
}): void {
  const registerHost = () => {
    void ensureExecutionHostRegistered({
      orchestratorUrl: options.orchestratorUrl,
      hostName: options.hostName,
      firecrackerHostUrl: options.firecrackerHostUrl,
    }).catch((error) => {
      console.error(
        "firecracker host re-registration failed:",
        error instanceof Error ? error.message : error,
      );
    });
  };
  setInterval(registerHost, options.intervalMs ?? 60_000).unref();
}
