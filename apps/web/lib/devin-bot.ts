export const DEVIN_BOT = {
  username: "baby-devin-bot",
  displayName: "devin",
  profileUrl: "https://github.com/baby-devin-bot",
  avatarUrl: "https://github.com/baby-devin-bot.png",
  email: "baby-devin-bot@users.noreply.github.com",
} as const;

export function isBrokenBotIdentity(value: string | undefined | null): boolean {
  if (!value?.trim()) {
    return true;
  }
  const trimmed = value.trim();
  return trimmed.includes("${") || trimmed.includes(":-");
}

export function displayBotUsername(value: string | undefined | null): string {
  if (isBrokenBotIdentity(value)) {
    return DEVIN_BOT.username;
  }
  return value!.trim();
}
