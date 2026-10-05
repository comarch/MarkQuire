import { test, expect } from "@playwright/test";

// Feature coverage for roadmap phase 1. Demo mode provides a mock token
// and localStorage-backed data, so no credentials are needed.

test("search panel finds text in the document", async ({ page }) => {
  await page.goto("/");

  await page.click('button[title="Search and replace (Ctrl+F)"]');

  const searchInput = page.locator(".cm-panel input").first();
  await expect(searchInput).toBeVisible();
  await searchInput.pressSequentially("Welcome");

  await expect(page.locator(".cm-searchMatch").first()).toBeVisible();
});

test("checking a task in the preview updates the markdown source", async ({
  page,
}) => {
  await page.goto("/");

  const unchecked = page
    .locator("input.task-list-item-checkbox:not([checked])")
    .first();
  await expect(unchecked).toBeVisible();
  await unchecked.click();

  // The editor renders the task as a checkbox widget whose state mirrors
  // the markdown source rewrite.
  await expect(page.locator(".cm-content")).toContainText(
    "Export directly to team Google Workspace Drive folder",
  );
  await expect(page.locator(".cm-content .cm-rich-task-checkbox")).toHaveCount(
    4,
  );
  await expect(
    page.locator(".cm-content .cm-rich-task-checkbox:checked"),
  ).toHaveCount(4);
  await expect(
    page.locator("input.task-list-item-checkbox[checked]"),
  ).toHaveCount(4);
});

test("version history lists, previews, and restores demo revisions", async ({
  page,
}) => {
  await page.goto("/");

  // Demo sign in without a configured client id issues a mock token.
  await page.click('button[title="Connect Google Drive"]');
  await expect(
    page.locator('button[title="Connect Google Drive"]'),
  ).toBeHidden();

  await page.click('button[title="New document (Create in Drive)"]');
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("Untitled Document");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nHistory demo line");

  // Auto-save runs after the configured delay and records a revision.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  await page.click('button[title="Version history"]');
  await expect(
    page.locator("h2", { hasText: "Version history" }),
  ).toBeVisible();

  const revisionButtons = page.locator('button:has-text("Demo User")');
  await expect(revisionButtons).toHaveCount(2, { timeout: 10_000 });

  // The newest revision matches the open document.
  await revisionButtons.first().click();
  await expect(
    page.getByText("No difference with the open document."),
  ).toBeVisible();

  // The initial revision lacks the typed line.
  await revisionButtons.nth(1).click();
  await expect(page.getByText("+ History demo line")).toBeVisible();

  // Restore the initial revision into the document.
  await page.getByText("Restore", { exact: true }).click();
  await expect(editor).toContainText("Untitled Document");
  await expect(editor).not.toContainText("History demo line");
});
