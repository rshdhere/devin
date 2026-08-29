import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["tests/**/*.spec.ts", "apps/**/*.spec.ts"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    navigationTimeout: 60_000,
    trace: "on-first-retry",
    video: "on",
    screenshot: "only-on-failure",
    storageState: process.env.E2E_STORAGE_STATE,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "cd ../../apps/web && bun run dev",
        url: "http://localhost:3000/login",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
