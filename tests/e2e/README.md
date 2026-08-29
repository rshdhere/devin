# End-to-end tests

Playwright journeys against the web app and platform surfaces. Specs mirror the repository layout under `tests/e2e/apps/`.

## Run locally

From the repository root:

```bash
bun install
cd tests/e2e && bun run test
```

The default config starts `apps/web` on port 3000 when `E2E_BASE_URL` is unset.

## Run against staging

```bash
E2E_BASE_URL=https://staging.devin.baby \
E2E_STORAGE_STATE=tests/e2e/.auth/staging.json \
cd tests/e2e && bun run test
```

Do not commit storage state files under `.auth/`.

## Layout

```text
tests/e2e/
├── tests/           # cross-cutting smoke checks
├── apps/
│   └── web/         # product UI journeys (mirrors apps/web)
└── playwright.config.ts
```
