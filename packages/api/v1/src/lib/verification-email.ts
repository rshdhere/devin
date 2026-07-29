import { createEmailVerificationToken } from "better-auth/api";
import { sendVerificationEmail } from "@devin/email";

function getWebAppUrl() {
  const base = process.env.WEB_APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/s`;
}

function getAuthBaseUrl() {
  const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:8080";
  const basePath = "/api/v1/auth";

  if (baseUrl.endsWith(basePath)) {
    return baseUrl;
  }

  return `${baseUrl.replace(/\/$/, "")}${basePath}`;
}

export async function deliverVerificationEmail(
  email: string,
  callbackURL = getWebAppUrl(),
) {
  const secret = process.env.BETTER_AUTH_SECRET;

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }

  const token = await createEmailVerificationToken(secret, email);
  const url = `${getAuthBaseUrl()}/verify-email?token=${token}&callbackURL=${encodeURIComponent(callbackURL)}`;

  await sendVerificationEmail({ to: email, url });
}
