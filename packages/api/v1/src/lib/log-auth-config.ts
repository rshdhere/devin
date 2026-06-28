import {
  getAuthPublicBaseUrl,
  getEffectiveGitHubOAuthCallbackUrl,
  getGitHubOAuthCallbackUrl,
  resolveOAuthProductionUrl,
  shouldUseOAuthProxy,
} from "./auth-url.js";

export function logAuthConfig() {
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
