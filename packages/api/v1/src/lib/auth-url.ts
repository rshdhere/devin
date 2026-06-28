export const AUTH_BASE_PATH = "/api/v1/auth" as const;

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

export function getAuthPublicOrigin(): string {
  const raw = process.env.BETTER_AUTH_URL?.trim();

  if (!raw) {
    throw new Error("BETTER_AUTH_URL is required");
  }

  return new URL(raw).origin;
}

export function getAuthPublicBaseUrl(): string {
  return `${getAuthPublicOrigin()}${AUTH_BASE_PATH}`;
}

export function getGitHubOAuthCallbackUrl(): string {
  return `${getAuthPublicBaseUrl()}/callback/github`;
}

export function resolveOAuthProductionUrl(): string | undefined {
  const explicit = process.env.OAUTH_PRODUCTION_URL?.trim();
  if (!explicit) {
    return undefined;
  }

  return trimTrailingSlashes(explicit);
}

export function shouldUseOAuthProxy(): boolean {
  const productionUrl = resolveOAuthProductionUrl();
  if (!productionUrl) {
    return false;
  }

  return new URL(productionUrl).origin !== getAuthPublicOrigin();
}

export function getEffectiveGitHubOAuthCallbackUrl(): string {
  const productionUrl = resolveOAuthProductionUrl();

  if (productionUrl && shouldUseOAuthProxy()) {
    return `${trimTrailingSlashes(productionUrl)}${AUTH_BASE_PATH}/callback/github`;
  }

  return getGitHubOAuthCallbackUrl();
}
