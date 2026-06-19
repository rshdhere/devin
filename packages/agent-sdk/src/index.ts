export interface RunRequest {
  taskId: string;
  prompt: string;
  agent?: string;
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
    return response.json() as Promise<RunResponse>;
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
}
