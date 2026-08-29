import { decryptAccountRecord, encryptAccountRecord } from "@devin/secrets";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
type AdapterFactory = ReturnType<typeof drizzleAdapter>;
type AdapterInstance = ReturnType<AdapterFactory>;

function isAccountModel(model: string | undefined): boolean {
  return model === "account";
}

function wrapAdapterInstance(base: AdapterInstance): AdapterInstance {
  return {
    ...base,
    async findOne(payload) {
      const result = await base.findOne(payload);
      if (!isAccountModel(payload?.model) || !result) {
        return result;
      }
      return decryptAccountRecord(result);
    },
    async findMany(payload) {
      const results = await base.findMany(payload);
      if (!isAccountModel(payload?.model) || !Array.isArray(results)) {
        return results;
      }
      return Promise.all(results.map((row) => decryptAccountRecord(row)));
    },
  };
}

export function createEncryptedDrizzleAdapter(
  db: Parameters<typeof drizzleAdapter>[0],
  config: DrizzleAdapterConfig,
): AdapterFactory {
  const baseFactory = drizzleAdapter(db, config);
  return ((options) =>
    wrapAdapterInstance(baseFactory(options))) as unknown as AdapterFactory;
}

export const accountTokenDatabaseHooks: BetterAuthOptions["databaseHooks"] = {
  account: {
    create: {
      async before(account) {
        return {
          data: await encryptAccountRecord(account),
        };
      },
    },
    update: {
      async before(account) {
        return {
          data: await encryptAccountRecord(account),
        };
      },
    },
  },
};
