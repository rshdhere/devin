import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/s");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByPlaceholder("Email address")).toBeVisible();
    await expect(page.getByRole("button", { name: /log in/i })).toBeVisible();
  });
});
