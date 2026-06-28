function parseOriginList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function getAllowedOrigins(): string[] {
  const origins = new Set<string>([
    process.env.WEB_APP_URL ?? "http://localhost:3000",
    process.env.BETTER_AUTH_URL ?? "http://localhost:8080",
    ...parseOriginList(process.env.CORS_ALLOWED_ORIGINS),
  ]);

  return [...origins];
}

export function isAllowedOrigin(origin: string | undefined): origin is string {
  if (!origin) {
    return false;
  }

  return getAllowedOrigins().includes(origin);
}
