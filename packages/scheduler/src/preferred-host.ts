/**
 * FirecrackerHost CR metadata.name — must match spec.preferredHost on sandboxes
 * so the orchestrator schedules VMs on the same machine as this scheduler.
 */
export function resolvePreferredHost(): string | undefined {
  const schedulerHost = process.env.SCHEDULER_HOST_NAME?.trim();
  if (schedulerHost) {
    return schedulerHost;
  }

  const firecrackerHost = process.env.FIRECRACKER_HOST_NAME?.trim();
  if (firecrackerHost) {
    return firecrackerHost;
  }

  return undefined;
}
