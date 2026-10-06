import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHtmlDocument, exportAsStaticSite } from "../utils/exportUtils";
import { inlineKatexFonts, katexFontNames } from "../utils/exportAssets";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const katexCss = readFileSync(
  resolve(process.cwd(), "node_modules/katex/dist/katex.min.css"),
  "utf8",
);

describe("buildHtmlDocument", () => {
  it("inlines styles instead of linking CDNs", () => {
    const html = buildHtmlDocument("Report.md", "# Title", {
      katexCss: "KATEX_MARKER",
      highlightCss: "HLJS_MARKER",
    });

    expect(html).toContain("<style>");
    expect(html).toContain("HLJS_MARKER");
    expect(html).toContain("KATEX_MARKER");
    expect(html).not.toMatch(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/);
    expect(html).not.toMatch(/<link\s+rel="stylesheet"/);
  });

  it("escapes the title and renders markdown content", () => {
    const html = buildHtmlDocument(
      'A "tricky" <title> & more',
      "# Heading\n\nbody text",
      { katexCss: "", highlightCss: "" },
    );

    expect(html).toContain(
      "<title>A &quot;tricky&quot; &lt;title&gt; &amp; more</title>",
    );
    expect(html).toMatch(/<h1[^>]*>Heading<\/h1>/);
    expect(html).toContain("body text");
  });
});

describe("exportAsStaticSite", () => {
  it("normalizes download names and uses a fallback for empty slugs", async () => {
    const downloadNames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadNames.push(this.download);
    });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:markquire"),
      revokeObjectURL: vi.fn(),
    });

    await exportAsStaticSite("!!! MarkQuire - Guide !!!", []);
    await exportAsStaticSite("!!!", []);

    expect(downloadNames).toEqual([
      "markquire-guide-site.html",
      "export-site.html",
    ]);
  });
});

describe("inlineKatexFonts", () => {
  it("replaces every woff2 font reference with a data URL", () => {
    const fonts = Object.fromEntries(
      katexFontNames.map((name) => [name, "data:font/woff2;base64,AAAA"]),
    );
    const inlined = inlineKatexFonts(katexCss, fonts);

    expect(inlined).not.toMatch(
      /url\((['"]?)fonts\/KaTeX_[A-Za-z0-9-]+\.woff2\1\)/,
    );
    expect(
      inlined.match(/data:font\/woff2/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(20);
  });

  it("leaves unknown fonts untouched", () => {
    const css = "src:url(fonts/KaTeX_Unknown-Regular.woff2) format('woff2')";
    expect(inlineKatexFonts(css, {})).toBe(css);
  });
});

describe("katexFontNames", () => {
  it("covers every font referenced by the bundled KaTeX CSS", () => {
    const referenced = [
      ...katexCss.matchAll(/fonts\/(KaTeX_[A-Za-z0-9-]+\.woff2)/g),
    ].map((match) => match[1]);
    const unique = new Set(referenced);

    expect(unique.size).toBeGreaterThanOrEqual(20);
    for (const font of unique) {
      expect(katexFontNames).toContain(font);
    }
  });
});
