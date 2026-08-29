# @devin/secrets

AWS KMS envelope encryption for OAuth tokens and per-task GitHub tokens.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `SECRETS_KMS_KEY_ID` | Production | KMS key ID or alias for envelope encryption |
| `LOCAL_SECRETS_KEY` | Local dev | 32-byte base64 static key when KMS is unavailable |

Generate a local key:

```sh
openssl rand -base64 32
```

## Rollout

1. Apply Terraform (`infra/modules/secrets-kms`) and set `SECRETS_KMS_KEY_ID` on API server, brain, and scheduler.
2. Run database migration `0006_encrypt_token_columns.sql`.
3. Deploy application code with encrypt-on-write and decrypt-on-read.
4. Run backfill: `bun run packages/drizzle/scripts/encrypt-existing-tokens.ts`
5. Verify new OAuth sign-ins and task creation still work; confirm `account.access_token` and `agent_sessions.github_token` blobs start with encrypted header byte `0x01`.

During dual-read, legacy UTF-8 plaintext bytea values remain readable until backfill completes.

## Key rotation

AWS KMS automatic key rotation rotates backing key material. Existing ciphertext remains decryptable. If replacing the KMS key entirely, decrypt with the old key and re-encrypt with the new key using the backfill script pattern.
