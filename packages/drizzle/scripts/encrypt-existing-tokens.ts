#!/usr/bin/env bun
/**
 * One-time backfill: encrypt plaintext OAuth/session tokens already stored as UTF-8 bytea.
 *
 * Usage:
 *   SECRETS_KMS_KEY_ID=... DATABASE_URL=... bun run packages/drizzle/scripts/encrypt-existing-tokens.ts
 *   LOCAL_SECRETS_KEY=... DATABASE_URL=... bun run packages/drizzle/scripts/encrypt-existing-tokens.ts
 */
import {
  encryptAccountTokenField,
  encryptSessionGithubToken,
  isEncrypted,
} from "@devin/secrets";
import { eq } from "drizzle-orm";
import { account, agentSessions } from "../src/database/schema.ts";
import { db } from "../src/index.ts";

async function backfillAccountTokens(): Promise<number> {
  let updated = 0;
  const rows = await db
    .select({
      id: account.id,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      idToken: account.idToken,
    })
    .from(account);

  for (const row of rows) {
    const needsAccess =
      row.accessToken != null &&
      Buffer.isBuffer(row.accessToken) &&
      !isEncrypted(row.accessToken);
    const needsRefresh =
      row.refreshToken != null &&
      Buffer.isBuffer(row.refreshToken) &&
      !isEncrypted(row.refreshToken);
    const needsId =
      row.idToken != null &&
      Buffer.isBuffer(row.idToken) &&
      !isEncrypted(row.idToken);

    if (!needsAccess && !needsRefresh && !needsId) {
      continue;
    }

    await db
      .update(account)
      .set({
        ...(needsAccess
          ? { accessToken: await encryptAccountTokenField(row.accessToken) }
          : {}),
        ...(needsRefresh
          ? { refreshToken: await encryptAccountTokenField(row.refreshToken) }
          : {}),
        ...(needsId
          ? { idToken: await encryptAccountTokenField(row.idToken) }
          : {}),
      })
      .where(eq(account.id, row.id));
    updated += 1;
  }

  return updated;
}

async function backfillSessionTokens(): Promise<number> {
  let updated = 0;
  const rows = await db
    .select({
      taskId: agentSessions.taskId,
      githubToken: agentSessions.githubToken,
    })
    .from(agentSessions);

  for (const row of rows) {
    const token = row.githubToken;
    if (token == null || !Buffer.isBuffer(token) || isEncrypted(token)) {
      continue;
    }

    await db
      .update(agentSessions)
      .set({
        githubToken: await encryptSessionGithubToken(token.toString("utf8")),
      })
      .where(eq(agentSessions.taskId, row.taskId));
    updated += 1;
  }

  return updated;
}

async function main(): Promise<void> {
  const accountRows = await backfillAccountTokens();
  const sessionRows = await backfillSessionTokens();
  console.log(
    `Encrypted ${accountRows} account row(s) and ${sessionRows} agent session row(s).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
