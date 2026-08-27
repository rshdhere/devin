/**
 * Public barrel for harness system prompt / message context helpers.
 * Implementation lives in ./context/* — keep this file as the stable import path.
 */
export { buildSystemPrompt, compactMessages } from "./context/index.js";
export type { BuildSystemPromptInput } from "./context/index.js";
