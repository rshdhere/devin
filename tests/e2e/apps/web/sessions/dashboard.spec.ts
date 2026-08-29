import { expect, test } from "@playwright/test";

test.describe("sessions dashboard", () => {
  test("requires authentication before showing the workspace", async ({
    page,
  }) => {
    await page.goto("/s");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByPlaceholder("Email address")).toBeVisible();
  });
});
