import type { TaskEventType, TaskStatus } from "@devin/types";

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "scheduling":
      return "Scheduling";
    case "drafting":
      return "Drafting plan";
    case "draft_ready":
      return "Draft ready";
    case "sandbox_starting":
      return "Booting devbox";
    case "runtime_ready":
      return "Devbox ready";
    case "running":
      return "Running";
    case "awaiting_review":
      return "Review changes";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

export function eventTypeLabel(type: TaskEventType): string {
  switch (type) {
    case "task.phase_changed":
      return "Phase";
    case "draft.started":
      return "Draft start";
    case "draft.updated":
      return "Draft update";
    case "draft.diff":
      return "Draft diff";
    case "draft.completed":
      return "Draft ready";
    case "draft.failed":
      return "Draft failed";
    case "execution.started":
      return "Execution";
    case "sandbox.requested":
      return "Devbox request";
    case "sandbox.provisioning":
      return "Devbox provisioning";
    case "sandbox.started":
      return "Devbox ready";
    case "sandbox.failed":
      return "Devbox error";
    case "runtime.waiting":
      return "Runtime health";
    case "runtime.ready":
      return "Runtime ready";
    case "agent.running":
      return "Agent";
    case "agent.log":
      return "Agent log";
    case "agent.output":
      return "Output";
    case "agent.tool":
      return "Tool";
    case "git.repo":
      return "Repo created";
    case "git.clone":
      return "Git clone";
    case "git.commit":
      return "Git commit";
    case "git.push":
      return "Git push";
    case "git.pr":
      return "Pull request";
    case "git.issue":
      return "Issue created";
    case "deploy.building":
      return "Production build";
    case "deploy.ready":
      return "Preview live";
    case "deploy.failed":
      return "Deploy failed";
    default:
      return type.replace(/\./g, " ");
  }
}

export function formatEventData(data?: Record<string, unknown>): string[] {
  if (!data) {
    return [];
  }

  const lines: string[] = [];
  const orderedKeys = [
    "sequence",
    "source",
    "phase",
    "message",
    "sandboxName",
    "runtime",
    "runtimeURL",
    "previewUrl",
    "slug",
    "upstreamHost",
    "upstreamPort",
    "pushedToGitHub",
    "vmId",
    "host",
    "orchestratorUrl",
    "timeoutSeconds",
    "status",
    "error",
    "sessionActive",
    "followUp",
    "runtimeAgent",
  ];

  for (const key of orderedKeys) {
    const value = data[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }

  for (const [key, value] of Object.entries(data)) {
    if (orderedKeys.includes(key)) {
      continue;
    }
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return lines;
}
