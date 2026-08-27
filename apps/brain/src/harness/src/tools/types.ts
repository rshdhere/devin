export type DevboxToolsClient = {
  Exec: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: ExecResult) => void,
  ) => void;
  ReadFile: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: { content?: string }) => void,
  ) => void;
  WriteFile: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: { status?: string; path?: string }) => void,
  ) => void;
  ListDir: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: { entries?: string[] }) => void,
  ) => void;
  GitClone: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: GitResult) => void,
  ) => void;
  GitCommit: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: GitResult) => void,
  ) => void;
  GitPush: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: GitResult) => void,
  ) => void;
  DesktopScreenshot: (
    req: Record<string, unknown>,
    cb: (
      err: Error | null,
      res: { png?: Buffer; contentType?: string },
    ) => void,
  ) => void;
  BrowserOpen: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: { status?: string }) => void,
  ) => void;
  close?: () => void;
};

export type ExecResult = {
  exitCode?: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
};

export type GitResult = {
  status?: string;
  message?: string;
};

export type ToolContext = {
  taskId: string;
  runtimeBaseUrl: string;
  workDir: string;
  client?: DevboxToolsClient;
  requireProductImplementation?: boolean;
  stackRuntime?: "nextjs" | "node" | "go" | "rust" | "python";
  /** When set, Devbox tools are proxied via the execution worker (Brain mode). */
  executionWorkerUrl?: string;
};

export type ToolResult = {
  content: string;
  done?: boolean;
  summary?: string;
};
