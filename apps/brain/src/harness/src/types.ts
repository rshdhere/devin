export type BrainHarnessEvent = {
  type:
    | "agent.started"
    | "agent.log"
    | "agent.tool"
    | "agent.output"
    | "agent.completed"
    | "agent.failed";
  message: string;
  data?: Record<string, unknown>;
};

export type BrainHarnessResult = {
  status: "completed" | "failed";
  message: string;
  output?: string;
  agent: "brain";
};

export type BrainHarnessOptions = {
  taskId: string;
  prompt: string;
  runtimeBaseUrl: string;
  workDir?: string;
  followUp?: boolean;
  /** Greenfield stack so prompts/gates match the scaffold (python ≠ nextjs). */
  stackRuntime?: "nextjs" | "node" | "go" | "rust" | "python";
  /** Greenfield: refuse finish while scaffold placeholder copy remains. */
  requireProductImplementation?: boolean;
  sessionContext?: string;
  recalledMemory?: string;
  maxSteps?: number;
  maxWaitMs?: number;
  model?: string;
  toolGatewayUrl?: string;
  openaiApiKey?: string;
  onEvent?: (event: BrainHarnessEvent) => void;
  onSaveMemory?: (facts: string[]) => Promise<void>;
  getAbortReason?: () => string | undefined;
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
