function parseOriginList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function registrableDomain(hostname: string): string | undefined {
  const host = hostname.trim().toLowerCase();
  if (!host || host === "localhost" || host === "127.0.0.1") {
    return undefined;
  }
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return parts.slice(-2).join(".");
}

function hostnameMatchesRegistrableDomain(
  hostname: string,
  rootDomain: string,
): boolean {
  const host = hostname.trim().toLowerCase();
  const root = rootDomain.trim().toLowerCase();
  return host === root || host.endsWith(`.${root}`);
}

function deriveWildcardOrigins(urls: string[]): string[] {
  const derived = new Set<string>();

  for (const url of urls) {
    try {
      const { protocol, hostname } = new URL(url);

      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname.endsWith(".localhost")
      ) {
        continue;
      }

      const parts = hostname.split(".");
      if (parts.length < 2) {
        continue;
      }

      const rootDomain = parts.slice(-2).join(".");
      derived.add(`${protocol}//${rootDomain}`);
      derived.add(`${protocol}//*.${rootDomain}`);
    } catch {
      continue;
    }
  }

  return [...derived];
}

function matchesWildcardOrigin(origin: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return origin === pattern;
  }

  try {
    const originUrl = new URL(origin);
    const [patternProtocol, patternRest] = pattern.split("://");

    if (originUrl.protocol !== `${patternProtocol}:`) {
      return false;
    }

    const patternHost = patternRest?.split("/")[0] ?? "";
    if (!patternHost.startsWith("*.")) {
      return false;
    }

    const rootDomain = patternHost.slice(2);

    return (
      originUrl.hostname === rootDomain ||
      originUrl.hostname.endsWith(`.${rootDomain}`)
    );
  } catch {
    return false;
  }
}

export function getAllowedOrigins(): string[] {
  const explicitOrigins = [
    process.env.WEB_APP_URL ?? "http://localhost:3000",
    process.env.BETTER_AUTH_URL ?? "http://localhost:8080",
    ...parseOriginList(process.env.CORS_ALLOWED_ORIGINS),
  ];

  const origins = new Set<string>([
    ...explicitOrigins,
    ...deriveWildcardOrigins(explicitOrigins),
  ]);

  return [...origins];
}

export function isAllowedOrigin(
  origin: string | undefined,
  apiHostname?: string,
): origin is string {
  if (!origin) {
    return false;
  }

  if (
    getAllowedOrigins().some((pattern) =>
      matchesWildcardOrigin(origin, pattern),
    )
  ) {
    return true;
  }

  // Staging often sets BETTER_AUTH_URL on the API host but forgets WEB_APP_URL.
  // Allow any browser origin on the same registrable domain as this API host
  // (e.g. staging.devin.ba → staging-api.devin.ba).
  const apiRoot = apiHostname ? registrableDomain(apiHostname) : undefined;
  if (apiRoot) {
    try {
      const originHost = new URL(origin).hostname;
      if (hostnameMatchesRegistrableDomain(originHost, apiRoot)) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

export function applyCorsHeaders(
  res: {
    setHeader(name: string, value: string): void;
  },
  origin: string | undefined,
  apiHostname?: string,
): boolean {
  if (!isAllowedOrigin(origin, apiHostname)) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Cookie",
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  return true;
}
