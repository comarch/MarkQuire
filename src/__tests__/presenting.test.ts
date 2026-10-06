import { describe, expect, it } from "vitest";
import { slideTitle, splitSlides } from "../utils/slides";
import { buildStaticSiteHtml } from "../utils/exportUtils";

describe("splitSlides", () => {
  it("splits on thematic breaks outside fences", () => {
    const doc =
      "# Deck\n\nIntro\n\n---\n\n## Two\n\n```md\n---\n```\n\n---\n\nEnd";
    const slides = splitSlides(doc);
    expect(slides).toHaveLength(3);
    expect(slides[0]).toContain("Intro");
    expect(slides[1]).toContain("## Two");
    expect(slides[1]).toContain("---"); // fenced break stays inside
    expect(slides[2]).toBe("End");
  });

  it("falls back to level-2 headings without breaks", () => {
    const doc = "# Deck\n\n## One\n\ntext\n\n## Two\n\nmore";
    const slides = splitSlides(doc);
    // The H1 title becomes the opening slide, sections follow.
    expect(slides).toHaveLength(3);
    expect(slides[0]).toContain("# Deck");
    expect(slides[1]).toContain("## One");
    expect(slides[2]).toContain("## Two");
  });

  it("strips frontmatter and keeps one slide for plain documents", () => {
    const slides = splitSlides("---\ntitle: x\n---\n\n# Only\n\nBody");
    expect(slides).toEqual(["# Only\n\nBody"]);
  });

  it("returns nothing for empty documents", () => {
    expect(splitSlides("---\nt: 1\n---\n\n")).toEqual([]);
  });
});

describe("slideTitle", () => {
  it("prefers the first heading", () => {
    expect(slideTitle("text\n\n## The Heading\n\nbody")).toBe("The Heading");
  });

  it("falls back to the first text line", () => {
    expect(slideTitle("Just a line\n\nmore")).toBe("Just a line");
  });

  it("supports tab-separated headings up to level six", () => {
    expect(slideTitle("####### Not a heading\n######\tDeep title")).toBe(
      "Deep title",
    );
  });
});

describe("buildStaticSiteHtml", () => {
  const pages = [
    { name: "Index.md", content: "# Index\n\nStart" },
    { name: "Guide.md", content: "# Guide\n\nSteps" },
  ];

  it("embeds every page with hash navigation", () => {
    const html = buildStaticSiteHtml("Handbook", pages, {
      katexCss: "KATEX",
      highlightCss: "HLJS",
    });

    expect(html).toContain('id="page-0"');
    expect(html).toContain('id="page-1"');
    expect(html).toContain('href="#page-1"');
    expect(html).toMatch(/<h1[^>]*>Index<\/h1>/);
    expect(html).toMatch(/<h1[^>]*>Guide<\/h1>/);
    expect(html).toContain("KATEX");
    expect(html).toContain("HLJS");
    // No external requests in the published site.
    expect(html).not.toMatch(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/);
    expect(html).not.toMatch(/https?:\/\/[^"'\s]*\.(js|css)/);
  });

  it("escapes page names in the navigation", () => {
    const html = buildStaticSiteHtml(
      "T",
      [{ name: "<script>.md", content: "x" }],
      { katexCss: "", highlightCss: "" },
    );
    expect(html).toContain("&lt;script&gt;.md");
    expect(html).not.toContain("<script>.md");
  });
});
