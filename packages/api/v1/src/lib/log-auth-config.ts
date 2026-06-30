import {
  getAuthPublicBaseUrl,
  getEffectiveGitHubOAuthCallbackUrl,
  getGitHubOAuthCallbackUrl,
  resolveOAuthProductionUrl,
  shouldUseOAuthProxy,
} from "./auth-url.js";
import { getAllowedOrigins } from "./cors.js";

function resolveCrossSubDomainCookieDomain(): string | undefined {
  const webAppUrl = process.env.WEB_APP_URL?.trim();
  const authUrl = process.env.BETTER_AUTH_URL?.trim();

  if (!webAppUrl || !authUrl) {
    return undefined;
  }

  try {
    const webHost = new URL(webAppUrl).hostname;
    const authHost = new URL(authUrl).hostname;

    if (webHost === authHost || webHost === "localhost") {
      return undefined;
    }

    const webRoot = webHost.split(".").slice(-2).join(".");
    const authRoot = authHost.split(".").slice(-2).join(".");

    if (webRoot === authRoot) {
      return `.${webRoot}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function shouldUseSecureCookies(): boolean {
  const authUrl = process.env.BETTER_AUTH_URL?.trim();
  if (authUrl?.startsWith("https://")) {
    return true;
  }

  const webAppUrl = process.env.WEB_APP_URL?.trim();
  if (webAppUrl?.startsWith("https://")) {
    return true;
  }

  return process.env.NODE_ENV === "production";
}

export function logAuthConfig() {
  const allowedOrigins = getAllowedOrigins();
  const crossSubDomainCookieDomain = resolveCrossSubDomainCookieDomain();
  const useSecureCookies = shouldUseSecureCookies();

  console.log(`auth config debug:`);
  console.log(`  WEB_APP_URL: ${process.env.WEB_APP_URL ?? "(not set)"}`);
  console.log(
    `  BETTER_AUTH_URL: ${process.env.BETTER_AUTH_URL ?? "(not set)"}`,
  );
  console.log(`  NODE_ENV: ${process.env.NODE_ENV ?? "(not set)"}`);
  console.log(`auth allowed origins: ${allowedOrigins.join(", ")}`);
  console.log(
    `auth secure cookies: ${useSecureCookies ? "enabled" : "disabled"}`,
  );
  console.log(
    crossSubDomainCookieDomain
      ? `auth cross-subdomain cookie domain: ${crossSubDomainCookieDomain} (sameSite=none, secure=true)`
      : "auth cross-subdomain cookies: disabled (WEB_APP_URL or BETTER_AUTH_URL not set, or same host)",
  );

  const hasOAuth =
    process.env.GITHUB_CLIENT_ID?.trim() ||
    process.env.GOOGLE_CLIENT_ID?.trim();

  if (!hasOAuth) {
    return;
  }

  console.log(`auth base URL: ${getAuthPublicBaseUrl()}`);
  console.log(
    `OAuth callback URLs (register in provider consoles): ${getAuthPublicBaseUrl()}/callback/{provider}`,
  );

  if (shouldUseOAuthProxy()) {
    console.log(
      `OAuth proxy enabled via ${resolveOAuthProductionUrl()} (sign-in uses production callback URL).`,
    );
    console.log(
      `Ensure production API (${resolveOAuthProductionUrl()}) shares GITHUB/GOOGLE credentials and BETTER_AUTH_SECRET.`,
    );
    console.log(
      `Proxied GitHub callback URL: ${getEffectiveGitHubOAuthCallbackUrl()}`,
    );
    console.log(`Local callback URL: ${getGitHubOAuthCallbackUrl()}`);
  }
}
