import { expect, test } from "@playwright/test";

test.describe("templates and snippets", () => {
  test("creates a document from a template and inserts a snippet", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".cm-content")).toContainText(
      "Welcome to Comarch MarkQuire",
    );

    // Open the templates modal from the header.
    await page.getByTitle("Templates and snippets").click();
    await expect(page.getByText("Templates and snippets")).toBeVisible();

    // Create a new document from the RFC template.
    await page.getByText("RFC", { exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("RFC: Welcome");
    await expect(
      page.locator(".cm-content .cm-rich-h2", {
        hasText: "Alternatives considered",
      }),
    ).toBeVisible();

    // The snippet tab inserts an expanded snippet at the cursor.
    await page.getByTitle("Templates and snippets").click();
    await page.getByRole("button", { name: "Snippets", exact: true }).click();
    await page.getByText("Today's date", { exact: true }).click();
    const today = new Date().toISOString().slice(0, 10);
    await expect(page.locator(".cm-content")).toContainText(today);
  });
});
