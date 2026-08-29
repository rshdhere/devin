# Integration tests

Unit tests (Bun + Vitest) and Playwright journeys live in this package.

## Unit tests

From the repository root:

```bash
bun install
cd tests/integration && bun run test
```

Unit tests mirror the repository layout under `tests/integration/packages/` and `tests/integration/apps/`.

## Playwright

```bash
bunx playwright test tests/integration/tests/session-journey.spec.ts --config tests/integration/playwright.config.ts
```

Run against staging with an authenticated Playwright storage state:

```bash
E2E_BASE_URL=https://staging.devin.baby \
E2E_STORAGE_STATE=tests/integration/.auth/staging.json \
bunx playwright test tests/integration/tests/session-journey.spec.ts --config tests/integration/playwright.config.ts
```

The test records video for the complete task journey. Authentication is intentionally supplied through `E2E_STORAGE_STATE`; do not commit that file.
