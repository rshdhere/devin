export interface PreviewRoute {
  slug: string;
  taskId: string;
  upstreamHost: string;
  upstreamPort: number;
  previewUrl: string;
  createdAt: string;
}

const routes = new Map<string, PreviewRoute>();

export function previewBaseDomain(): string {
  return (
    process.env.PREVIEW_BASE_DOMAIN?.trim() ||
    "3897534985y30589y3ruwehrkjsehfr8er34858w36.devin.baby"
  );
}

export function previewDeployEnabled(): boolean {
  const flag = process.env.PREVIEW_DEPLOY_ENABLED?.trim().toLowerCase();
  if (flag === "false" || flag === "0" || flag === "no") {
    return false;
  }
  return true;
}

export function buildPreviewUrl(slug: string): string {
  const scheme = process.env.PREVIEW_URL_SCHEME?.trim() || "https";
  return `${scheme}://${slug}.${previewBaseDomain()}`;
}

export function generatePreviewSlug(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function matchPreviewSlug(host: string): string | null {
  const normalized = host.toLowerCase();
  const base = previewBaseDomain().toLowerCase();
  if (!normalized.endsWith(`.${base}`) && normalized !== base) {
    return null;
  }
  if (normalized === base) {
    return null;
  }
  const slug = normalized.slice(0, -(base.length + 1));
  if (!slug || slug.includes(".")) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/i.test(slug)) {
    return null;
  }
  return slug;
}

/** True when Caddy may mint an on-demand cert for this domain. */
export function isPreviewTlsDomainAllowed(domain: string): boolean {
  const host = domain.trim().toLowerCase().split(":")[0] ?? "";
  if (!host) {
    return false;
  }
  // Registered live preview slug, or syntactically valid future slug on base.
  if (matchPreviewSlug(host)) {
    return true;
  }
  return false;
}

export function registerPreviewRoute(route: PreviewRoute): void {
  routes.set(route.slug, route);
}

export function getPreviewRoute(slug: string): PreviewRoute | undefined {
  return routes.get(slug);
}

export function listPreviewRoutes(): PreviewRoute[] {
  return [...routes.values()];
}
