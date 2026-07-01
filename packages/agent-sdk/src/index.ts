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
}

export interface GitPushRequest {
  taskId?: string;
  remote?: string;
  branch?: string;
  cwd?: string;
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
}

export class RuntimeClient {
  constructor(private readonly options: RuntimeClientOptions) {}

  private base(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async run(body: RunRequest): Promise<RunResponse> {
    const response = await fetch(this.base("/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const response = await fetch(
      `${this.base("/run/status")}?taskId=${encodeURIComponent(taskId)}`,
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
    opts?: { pollIntervalMs?: number },
  ): Promise<RunResponse> {
    const pollIntervalMs = opts?.pollIntervalMs ?? 3_000;
    const accepted = await this.run(body);
    if (accepted.status === "completed" || accepted.status === "failed") {
      return accepted;
    }

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const status = await this.runStatus(body.taskId);
      if (status.status === "completed" || status.status === "failed") {
        return status;
      }
    }
  }

  async writeFile(
    body: FileWriteRequest,
  ): Promise<{ status: string; path: string }> {
    const response = await fetch(this.base("/files/write"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<{ status: string; path: string }>;
  }

  async health(): Promise<RuntimeHealthResponse> {
    const response = await fetch(this.base("/health"));
    return response.json() as Promise<RuntimeHealthResponse>;
  }

  async terminal(body: TerminalRequest): Promise<TerminalResponse> {
    const response = await fetch(this.base("/terminal"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<TerminalResponse>;
  }

  async gitClone(
    body: GitCloneRequest,
  ): Promise<{ status: string; path: string }> {
    const response = await fetch(this.base("/git/clone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<{ status: string; path: string }>;
  }

  async gitCommit(
    body: GitCommitRequest,
  ): Promise<{ status: string; message: string; output?: string }> {
    const response = await fetch(this.base("/git/commit"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<{
      status: string;
      message: string;
      output?: string;
    }>;
  }

  async gitPush(
    body: GitPushRequest,
  ): Promise<{ status: string; branch?: string; output?: string }> {
    const response = await fetch(this.base("/git/push"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<{
      status: string;
      branch?: string;
      output?: string;
    }>;
  }
}
