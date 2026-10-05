import { expect, test } from "@playwright/test";

// Roadmap item 25: the WYSIWYG overlay hides raw Markdown marks in the
// editor without touching the document bytes. The overlay is on by
// default; the cursor's active line stays raw so hidden delimiters
// remain editable, exactly like Typora.

// Documents are pasted, not typed: CodeMirror input rules auto-continue
// list and quote markers on Enter, so typed list lines would accumulate
// injected markers and corrupt the fixture.
async function replaceDocument(page, text) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+v");
}

test.describe("rich view WYSIWYG overlay", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });

  test("renders rich by default and reveals raw marks while editing", async ({
    page,
  }) => {
    await page.goto("/");
    await replaceDocument(
      page,
      "# Title\n\n**bold** and *italic* text with `code`\n",
    );

    // The overlay is on by default, so marks disappear from rendered lines.
    await expect(page.locator(".cm-content")).toContainText(
      "bold and italic text with code",
    );
    const lineText = await page.locator(".cm-content").innerText();
    expect(lineText).not.toContain("**");
    expect(lineText).not.toContain("`");
    expect(lineText).not.toContain("#");
    await expect(page.locator(".cm-content .cm-rich-h1")).toHaveCount(1);
    await expect(page.locator(".cm-content .cm-rich-bold")).toHaveCount(1);
    await expect(page.locator(".cm-content .cm-rich-italic")).toHaveCount(1);

    // The preview keeps rendering the original Markdown, proving the
    // overlay never mutated the document.
    await expect(page.locator(".preview-container")).toContainText(
      "bold and italic text with code",
    );

    // Placing the cursor on the bold line reveals its raw delimiters.
    const bold = page.locator(".cm-content .cm-rich-bold");
    await bold.click();
    await expect(page.locator(".cm-content")).toContainText("**bold**");

    // Leaving the editor renders the whole document again.
    await page.locator(".preview-container").click();
    await expect(page.locator(".cm-content")).not.toContainText("**bold**");

    // Toggle off: raw marks return, so the bytes survived the overlay.
    await page.getByTitle("Rich text view").click();
    await expect(page.locator(".cm-content")).toContainText("**bold**");
    await expect(page.locator(".cm-content")).toContainText("`code`");
  });

  test("styles links as labels only", async ({ page }) => {
    await page.goto("/");
    await replaceDocument(
      page,
      "intro\n\nSee [the docs](https://external.example/guide) for details\n",
    );

    const text = await page.locator(".cm-content").innerText();
    expect(text).toContain("See the docs for details");
    expect(text).not.toContain("https://");
    await expect(page.locator(".cm-content .cm-rich-link-text")).toHaveCount(1);

    // Toggle off restores the raw link syntax.
    await page.getByTitle("Rich text view").click();
    await expect(page.locator(".cm-content")).toContainText(
      "[the docs](https://external.example/guide)",
    );
  });

  test("renders blocks: quotes, bullets, task checkboxes, rules, math", async ({
    page,
  }) => {
    await page.goto("/");
    await replaceDocument(
      page,
      [
        "text",
        "",
        "> quoted line",
        "",
        "- one",
        "- two",
        "",
        "- [ ] open task",
        "- [x] done task",
        "",
        "---",
        "",
        "$$a^2 + b^2 = c^2$$ and $x^2$ inline",
        "",
        "tail",
        "",
      ].join("\n"),
    );

    // Blockquote mark hides behind the quoted line class.
    await expect(page.locator(".cm-content .cm-rich-quote")).toHaveCount(1);
    const quoted = await page.locator(".cm-content .cm-rich-quote").innerText();
    expect(quoted).not.toContain(">");

    // Bullets become glyphs, tasks become checkboxes.
    await expect(page.locator(".cm-content .cm-rich-bullet")).toHaveCount(4);
    const checkboxes = page.locator(".cm-content .cm-rich-task-checkbox");
    await expect(checkboxes).toHaveCount(2);
    await expect(
      page.locator(".cm-content .cm-rich-task-checkbox:checked"),
    ).toHaveCount(1);

    // The horizontal rule renders as a styled line, not dashes.
    await expect(page.locator(".cm-content .cm-rich-hr")).toHaveCount(1);

    // Math renders through KaTeX, display and inline.
    await expect(page.locator(".cm-content .cm-rich-math")).toHaveCount(2);
    await expect(page.locator(".cm-content .katex").first()).toBeVisible();

    // Clicking an editor checkbox rewrites the task markdown source.
    await checkboxes.first().click();
    await expect(
      page.locator(".cm-content .cm-rich-task-checkbox:checked"),
    ).toHaveCount(2);

    // Toggling the overlay off proves the click only changed bytes,
    // not the rendering.
    await page.getByTitle("Rich text view").click();
    await expect(page.locator(".cm-content")).toContainText("- [x] open task");
  });

  test("hides code fence marks and tags the language", async ({ page }) => {
    await page.goto("/");
    await replaceDocument(page, "intro\n\n```js\nconst a = 1;\n```\n\ntail\n");

    const text = await page.locator(".cm-content").innerText();
    expect(text).toContain("const a = 1;");
    expect(text).not.toContain("```");
    await expect(page.locator(".cm-content .cm-rich-code-lang")).toHaveText(
      "js",
    );
    await expect(page.locator(".cm-content .cm-rich-code-line")).toHaveCount(1);
  });
});
