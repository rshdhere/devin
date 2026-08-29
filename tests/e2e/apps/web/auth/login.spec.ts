import { expect, test } from "@playwright/test";

test.describe("auth", () => {
  test("renders the login form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByPlaceholder("Email address")).toBeVisible();
    await expect(page.getByRole("button", { name: /log in/i })).toBeVisible();
  });
});
