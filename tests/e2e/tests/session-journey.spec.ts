import { expect, test } from "@playwright/test";

test.describe("Devin session journey", () => {
  test("creates a task and visits every session workspace surface", async ({
    page,
  }) => {
    test.setTimeout(10 * 60 * 1000);

    await page.goto("/s");
    await expect(
      page.getByPlaceholder(/ask devin to build features/i).first(),
    ).toBeVisible();

    const prompt =
      process.env.E2E_PROMPT ??
      "Create a small Go HTTP service with a /health endpoint and write a README.";
    await page
      .getByPlaceholder(/ask devin to build features/i)
      .first()
      .fill(prompt);
    await page.getByRole("button", { name: /send prompt/i }).click();

    await expect(page).toHaveURL(/\/s\/[^/]+/, { timeout: 30_000 });
    await expect(page.getByText(/working|awaiting|devin/i).first()).toBeVisible(
      {
        timeout: 30_000,
      },
    );

    for (const tab of ["Progress", "Changes", "Desktop"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await expect(
        page.getByRole("button", { name: tab, exact: true }),
      ).toBeVisible();
    }

    await page.getByRole("button", { name: "Desktop", exact: true }).click();
    await expect(
      page.getByText(/desktop|interactive desktop|preparing desktop/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    await expect(
      page.getByPlaceholder(/ask devin to build features/i).last(),
    ).toBeVisible();
    await page
      .getByPlaceholder(/ask devin to build features/i)
      .last()
      .fill("Please confirm the service has a working health endpoint.");
    await page.getByRole("button", { name: /send message/i }).click();

    await expect
      .poll(
        async () =>
          await page
            .getByText(
              /recording|no session recording|loading session recording/i,
            )
            .count(),
        { timeout: 5 * 60 * 1000 },
      )
      .toBeGreaterThan(0);
  });
});
