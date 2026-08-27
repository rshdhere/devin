import type { ChatMessage } from "../types.js";

export function compactMessages(
  messages: ChatMessage[],
  summary: string,
): ChatMessage[] {
  const system = messages.find((m) => m.role === "system");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const next: ChatMessage[] = [];
  if (system) {
    next.push(system);
  }
  next.push({
    role: "user",
    content: `Conversation summary so far:\n${summary}\n\nContinue from here.`,
  });
  if (lastUser && lastUser.content) {
    next.push(lastUser);
  }
  return next;
}
