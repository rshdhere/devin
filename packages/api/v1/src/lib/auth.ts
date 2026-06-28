import { db } from "@devin/drizzle";
import { schema } from "@devin/drizzle/schema";
import { sendMagicLinkEmail, sendVerificationEmail } from "@devin/email";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth, magicLink } from "better-auth/plugins";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";
import { resolveOAuthProductionUrl, shouldUseOAuthProxy } from "./auth-url.js";
import { getAllowedOrigins } from "./cors.js";
import { deliverVerificationEmail } from "./verification-email.js";
import { logAuthConfig } from "./log-auth-config.js";

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const windsurfClientId = process.env.WINDSURF_CLIENT_ID;
const windsurfClientSecret = process.env.WINDSURF_CLIENT_SECRET;
const windsurfDiscoveryUrl = process.env.WINDSURF_DISCOVERY_URL;

const socialProviders: NonNullable<
  Parameters<typeof betterAuth>[0]["socialProviders"]
> = {};

if (githubClientId && githubClientSecret) {
  socialProviders.github = {
    clientId: githubClientId,
    clientSecret: githubClientSecret,
    scope: ["read:user", "user:email", "repo"],
  };
}

if (googleClientId && googleClientSecret) {
  socialProviders.google = {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
  };
}

const oauthProviders = [];

if (windsurfClientId && windsurfClientSecret && windsurfDiscoveryUrl) {
  oauthProviders.push({
    providerId: "windsurf",
    clientId: windsurfClientId,
    clientSecret: windsurfClientSecret,
    discoveryUrl: windsurfDiscoveryUrl,
  });
}

const authPlugins = [
  magicLink({
    sendMagicLink: async ({ email, url }) => {
      await sendMagicLinkEmail({ to: email, url });
    },
  }),
  ...(oauthProviders.length > 0
    ? [genericOAuth({ config: oauthProviders })]
    : []),
];

if (shouldUseOAuthProxy()) {
  authPlugins.unshift(
    oAuthProxy({
      productionURL: resolveOAuthProductionUrl(),
      currentURL: process.env.BETTER_AUTH_URL,
    }),
  );
}

export const auth = betterAuth({
  basePath: "/api/v1/auth",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: getAllowedOrigins(),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    autoSignIn: false,
    onExistingUserSignUp: async ({ user }) => {
      if (user.emailVerified) {
        return;
      }

      await deliverVerificationEmail(user.email);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, url });
    },
  },
  socialProviders,
  plugins: authPlugins,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: schema,
  }),
});

logAuthConfig();
