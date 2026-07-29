# `@devin/drizzle`

Postgres access for Devin via Drizzle ORM. Owns the schema (Better Auth tables,
tasks, sessions, dashboard settings) and migration helpers.

## Exports

| Export | Path | Purpose |
| ------ | ---- | ------- |
| `db` | `@devin/drizzle` | Shared Drizzle client (`DATABASE_URL`) |
| schema | `@devin/drizzle/schema` | Table definitions |
| `ensureDBConnection` | `@devin/drizzle/health` | Startup connectivity check |
| `runMigrations` | `@devin/drizzle/migrate` | Apply SQL migrations |

## Layout

```text
src/
  index.ts              # drizzle(process.env.DATABASE_URL)
  health.ts
  migrate.ts
  database/schema.ts
drizzle/                # Generated SQL migrations
drizzle.config.ts
compose.yaml            # Local Postgres for development
```

## Develop

```bash
# From packages/drizzle
bun run migrate

# Visualize schema (repo root)
bun run schema
bun run studio
```

Requires `DATABASE_URL` (see `.env.sample`).
