import {
  parseRuntimeResponse,
  parseRuntimeResponseAllowFailure,
} from "./runtime-response.js";

export interface RunRequest {
  taskId: string;
  prompt: string;
  agent?: string;
  workDir?: string;
  env?: Record<string, string>;
}

export interface RunResponse {
  taskId: string;
  status: "accepted" | "running" | "completed" | "failed";
  message: string;
  output?: string;
  agent?: string;
}

export interface TerminalRequest {
  taskId?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalResponse {
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitCloneRequest {
  taskId?: string;
  url: string;
  path?: string;
}

export interface GitCommitRequest {
  taskId?: string;
  message: string;
  paths?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface GitPushRequest {
  taskId?: string;
  remote?: string;
  branch?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface FileWriteRequest {
  path: string;
  content: string;
}

export interface BrowserOpenRequest {
  url: string;
}

export interface RuntimeHealthResponse {
  status: "ok";
  taskId?: string;
}

export interface RuntimeEvent {
  id?: string;
  taskId?: string;
  type: string;
  message: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface RuntimeClientOptions {
  baseUrl: string;
  fetchTimeoutMs?: number;
}

const DEFAULT_RUNTIME_FETCH_TIMEOUT_MS = 35 * 60 * 1000;

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** Node's fetch uses undici with a 300s default headersTimeout — too short for blocking /terminal calls. */
let runtimeFetchDispatcher: RequestInit["dispatcher"];

async function resolveRuntimeFetchDispatcher(
  timeoutMs: number,
): Promise<RequestInit["dispatcher"]> {
  // Bun's native fetch ignores undici's Agent/dispatcher; skip the import.
  if (isBunRuntime()) {
    return undefined;
  }
  if (runtimeFetchDispatcher) {
    return runtimeFetchDispatcher;
  }
  try {
    const undici = await import("undici");
    // Keep headers/body timeouts aligned with AbortSignal so long /terminal
    // calls (npm install, builds) are not killed by undici's 300s default.
    runtimeFetchDispatcher = new undici.Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      connectTimeout: 30_000,
    }) as RequestInit["dispatcher"];
    return runtimeFetchDispatcher;
  } catch (error) {
    console.warn(
      "undici Agent unavailable; runtime fetch may hit the 300s default headersTimeout",
      error,
    );
    return undefined;
  }
}

export class RuntimeClient {
  private readonly fetchTimeoutMs: number;
  private readonly options: RuntimeClientOptions;

  constructor(options: RuntimeClientOptions | string) {
    this.options = typeof options === "string" ? { baseUrl: options } : options;
    this.fetchTimeoutMs =
      this.options.fetchTimeoutMs ?? DEFAULT_RUNTIME_FETCH_TIMEOUT_MS;
  }

  private base(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async fetchRuntime(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const dispatcher = await resolveRuntimeFetchDispatcher(this.fetchTimeoutMs);
    // Bun hardcodes a ~5 minute fetch idle timeout and does not honor a longer
    // AbortSignal alone (oven-sh/bun#16682). `timeout: false` disables that
    // ceiling so npm install / builds can finish; AbortSignal still bounds the
    // overall request. Node ignores the unknown option and uses undici above.
    const requestInit: RequestInit & { timeout?: false | number } = {
      ...init,
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    };
    if (isBunRuntime()) {
      requestInit.timeout = false;
    }
    return fetch(this.base(path), requestInit);
  }

  private envHeaders(env?: Record<string, string>): Record<string, string> {
    if (!env || Object.keys(env).length === 0) {
      return {};
    }
    return { "X-Runtime-Env": JSON.stringify(env) };
  }

  async run(body: RunRequest): Promise<RunResponse> {
    const response = await this.fetchRuntime("/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.envHeaders(body.env),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        errorBody || `Runtime run failed with status ${response.status}`,
      );
    }
    return response.json() as Promise<RunResponse>;
  }

  async runStatus(taskId: string): Promise<RunResponse> {
    const response = await this.fetchRuntime(
      `/run/status?taskId=${encodeURIComponent(taskId)}`,
    );
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        errorBody || `Runtime status failed with status ${response.status}`,
      );
    }
    return response.json() as Promise<RunResponse>;
  }

  async runAndWait(
    body: RunRequest,
    opts?: { pollIntervalMs?: number; maxWaitMs?: number },
  ): Promise<RunResponse> {
    const pollIntervalMs = opts?.pollIntervalMs ?? 3_000;
    const maxWaitMs = opts?.maxWaitMs ?? 30 * 60 * 1000;
    const deadline = Date.now() + maxWaitMs;
    const accepted = await this.run(body);
    if (accepted.status === "completed" || accepted.status === "failed") {
      return accepted;
    }

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const status = await this.runStatus(body.taskId);
      if (status.status === "completed" || status.status === "failed") {
        return status;
      }
    }

    throw new Error(
      `Agent run for task ${body.taskId} did not finish within ${Math.round(maxWaitMs / 1000)}s`,
    );
  }

  async writeFile(
    body: FileWriteRequest,
  ): Promise<{ status: string; path: string }> {
    const response = await this.fetchRuntime("/files/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseRuntimeResponse(response);
  }

  async health(): Promise<RuntimeHealthResponse> {
    const response = await this.fetchRuntime("/health");
    if (!response.ok) {
      throw new Error(`Runtime health check failed (HTTP ${response.status})`);
    }
    return response.json() as Promise<RuntimeHealthResponse>;
  }

  async ensureDns(): Promise<boolean> {
    try {
      const response = await this.fetchRuntime("/dns/ensure", {
        method: "POST",
      });
      await parseRuntimeResponse(response);
      return true;
    } catch {
      return false;
    }
  }

  async terminal(body: TerminalRequest): Promise<TerminalResponse> {
    const response = await this.fetchRuntime("/terminal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.envHeaders(body.env),
      },
      body: JSON.stringify(body),
    });
    return parseRuntimeResponse(response);
  }

  async terminalAllowFailure(body: TerminalRequest): Promise<TerminalResponse> {
    const response = await this.fetchRuntime("/terminal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.envHeaders(body.env),
      },
      body: JSON.stringify(body),
    });
    return parseRuntimeResponseAllowFailure(response);
  }

  async gitClone(
    body: GitCloneRequest,
  ): Promise<{ status: string; path: string }> {
    const response = await this.fetchRuntime("/git/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseRuntimeResponse(response);
  }

  async gitCommit(
    body: GitCommitRequest,
  ): Promise<{ status: string; message: string; output?: string }> {
    const response = await this.fetchRuntime("/git/commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.envHeaders(body.env),
      },
      body: JSON.stringify(body),
    });
    return parseRuntimeResponse(response);
  }

  async gitPush(
    body: GitPushRequest,
  ): Promise<{ status: string; branch?: string; output?: string }> {
    const response = await this.fetchRuntime("/git/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.envHeaders(body.env),
      },
      body: JSON.stringify(body),
    });
    return parseRuntimeResponse(response);
  }
}
