import type { BrainStackRuntime } from "../stack.js";

export type BuildSystemPromptInput = {
  workDir: string;
  followUp?: boolean;
  requireProductImplementation?: boolean;
  stackRuntime?: BrainStackRuntime;
  sessionContext?: string;
  recalledMemory?: string;
  repoListing?: string;
};
