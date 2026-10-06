import { describe, expect, it } from "vitest";
import {
  extractSections,
  generateTableOfContents,
  moveSectionBy,
  numberHeadings,
} from "../utils/structure";

const DOC = `# Title

Intro.

## Alpha

alpha text

### Alpha detail

detail text

## Beta

beta text

## Gamma

gamma text

Tail line.`;

describe("extractSections", () => {
  it("extends a section until the next same-or-shaller heading", () => {
    const sections = extractSections(DOC);

    expect(sections.map((s) => s.text)).toEqual([
      "Title",
      "Alpha",
      "Alpha detail",
      "Beta",
      "Gamma",
    ]);
    const alpha = sections[1];
    expect(alpha?.headingLine).toBe(5);
    expect(alpha?.endLine).toBe(12); // includes the subsection
    const gamma = sections[4];
    expect(gamma?.endLine).toBe(21); // runs to the end of the document
  });

  it("ignores headings inside code fences", () => {
    const fenced = "# Real\n\ntext\n\n```md\n## Not a heading\n```\n";
    const sections = extractSections(fenced);
    expect(sections.map((s) => s.text)).toEqual(["Real"]);
  });
});

describe("moveSectionBy", () => {
  it("moves a section down with its subsection", () => {
    const moved = moveSectionBy(DOC, 5, 1);

    const lines = moved.split("\n");
    expect(lines[4]?.startsWith("## Beta")).toBe(true);
    expect(moved).toContain("alpha text");
    expect(moved).toContain("### Alpha detail");
    // The whole Alpha section (text plus subsection) moved below Beta.
    expect(moved.indexOf("beta text")).toBeLessThan(
      moved.indexOf("alpha text"),
    );
    expect(moved.endsWith("Tail line.")).toBe(true);
  });

  it("moves a section up", () => {
    const moved = moveSectionBy(DOC, 17, -1);
    expect(moved.indexOf("gamma text")).toBeLessThan(
      moved.indexOf("beta text"),
    );
  });

  it("keeps the document unchanged at the edges", () => {
    expect(moveSectionBy(DOC, 5, -1)).toBe(DOC); // no earlier H2 sibling
    expect(moveSectionBy(DOC, 17, 1)).toBe(DOC); // no later H2 sibling
  });

  it("ignores unknown heading lines", () => {
    expect(moveSectionBy(DOC, 3, 1)).toBe(DOC);
  });
});

describe("numberHeadings", () => {
  it("numbers level 2+ headings hierarchically and skips the title", () => {
    const numbered = numberHeadings(DOC, true);

    expect(numbered).toContain("# Title");
    expect(numbered).toContain("## 1. Alpha");
    expect(numbered).toContain("### 1.1. Alpha detail");
    expect(numbered).toContain("## 2. Beta");
    expect(numbered).toContain("## 3. Gamma");
  });

  it("round-trips numbering on and off", () => {
    const numbered = numberHeadings(DOC, true);
    const restored = numberHeadings(numbered, false);
    expect(restored).toBe(DOC);
  });

  it("leaves fenced code untouched", () => {
    const fenced = "## Head\n\n```md\n## Keep\n```\n";
    const numbered = numberHeadings(fenced, true);
    expect(numbered).toContain("## 1. Head");
    expect(numbered).toContain("## Keep");
  });

  it("strips only valid generated number prefixes", () => {
    const markdown =
      "## 1.2. Existing number\n" +
      "## 1234567890. Long component\n" +
      "## 1.. Invalid number\n";
    expect(numberHeadings(markdown, false)).toBe(
      "## Existing number\n" +
        "## 1234567890. Long component\n" +
        "## 1.. Invalid number\n",
    );
    expect(numberHeadings("## 1234567890. Long component", true)).toBe(
      "## 1. 1234567890. Long component",
    );
  });
});

describe("generateTableOfContents", () => {
  it("links level 2+ headings with anchors and nesting", () => {
    const toc = generateTableOfContents(DOC);

    expect(toc).toContain("- [Alpha](#alpha)");
    expect(toc).toContain("  - [Alpha detail](#alpha-detail)");
    expect(toc).toContain("- [Beta](#beta)");
    expect(toc).not.toContain("[Title]");
  });

  it("returns empty for documents without sections", () => {
    expect(generateTableOfContents("plain text")).toBe("");
  });
});
