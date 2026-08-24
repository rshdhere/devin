import { createDevboxToolsClient, executeTool } from "@devin/brain-harness";
import type { TaskService } from "./task-service.js";
import { resolveRuntimeSession } from "./resolve-session-proxy.js";

export type ToolProxyRequest = {
  name: string;
  arguments?: string;
  workDir?: string;
  stackRuntime?: "nextjs" | "node" | "go" | "rust" | "python";
  requireProductImplementation?: boolean;
};

export type ToolProxyResponse = {
  content: string;
  done?: boolean;
  summary?: string;
};

/**
 * Worker-side Devbox tool proxy: resolve the live session by taskId and dial
 * the host-local tool-gateway. Brain never needs guest CNI addresses.
 */
export async function proxyDevboxTool(
  svc: TaskService,
  taskId: string,
  body: ToolProxyRequest,
): Promise<ToolProxyResponse> {
  const name = body.name?.trim();
  if (!name) {
    return { content: "tool error: name is required" };
  }

  const session = await resolveRuntimeSession(svc, taskId);
  if (!session?.runtimeBaseUrl) {
    return { content: "tool error: no devbox session" };
  }

  const gateway = process.env.TOOL_GATEWAY_GRPC_URL?.trim() || "127.0.0.1:9095";
  const client = createDevboxToolsClient(gateway);
  const workDir = body.workDir?.trim() || session.repoCwd || "repo";

  return executeTool(
    {
      taskId,
      runtimeBaseUrl: session.runtimeBaseUrl,
      workDir,
      client,
      requireProductImplementation: body.requireProductImplementation === true,
      stackRuntime: body.stackRuntime,
    },
    name,
    body.arguments ?? "{}",
  );
}
