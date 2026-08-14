# Devin end-to-end tests

Install dependencies from the repository root:

```bash
bun install
```

Run the local journey:

```bash
bunx playwright test tests/e2e/tests/session-journey.spec.ts
```

Run against staging with an authenticated Playwright storage state:

```bash
E2E_BASE_URL=https://staging.devin.baby \
E2E_STORAGE_STATE=tests/e2e/.auth/staging.json \
bunx playwright test tests/e2e/tests/session-journey.spec.ts
```

The test records video for the complete task journey. Authentication is
intentionally supplied through `E2E_STORAGE_STATE`; do not commit that file.
