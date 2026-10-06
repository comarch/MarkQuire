import { describe, expect, it } from "vitest";
import { computeBacklinks, scanOutgoingLinks } from "../services/linkIndex";

describe("scanOutgoingLinks", () => {
  it("extracts wikilinks with and without labels", () => {
    const links = scanOutgoingLinks(
      "See [[Notes]] and [[Glossary|the glossary]].",
    );
    expect(links).toEqual([
      { target: "Notes", kind: "wikilink" },
      { target: "Glossary", kind: "wikilink" },
    ]);
  });

  it("extracts relative Markdown links and ignores the rest", () => {
    const links = scanOutgoingLinks(
      "[Home](index.md), [web](https://external.example), " +
        "[anchor](#section), [mail](mailto:a@b.c), [pic](pic.png)",
    );
    expect(links).toEqual([{ target: "index.md", kind: "md-link" }]);
  });

  it("continues after malformed links with nested opening brackets", () => {
    expect(scanOutgoingLinks("[outer](bad path [Guide](guide.md)")).toEqual([
      { target: "guide.md", kind: "md-link" },
    ]);
  });

  it("skips fenced code blocks", () => {
    const content = "[[Real]]\n\n```md\n[[Fake]] and [x](fake.md)\n```\n";
    expect(scanOutgoingLinks(content)).toEqual([
      { target: "Real", kind: "wikilink" },
    ]);
  });

  it("keeps fragments out of targets", () => {
    const links = scanOutgoingLinks("[[Notes#intro]] and [a](notes.md#part)");
    expect(links.map((l) => l.target)).toEqual([
      "Notes#intro",
      "notes.md#part",
    ]);
  });
});

describe("computeBacklinks", () => {
  const documents = [
    {
      id: "a",
      name: "Index.md",
      content: "Start in [[Notes]] then read [deep](Notes.md#intro).",
    },
    { id: "b", name: "Notes.md", content: "Back to [[Index]]." },
    { id: "c", name: "Other.md", content: "No links here." },
  ];

  it("lists documents linking to the current one", () => {
    const backlinks = computeBacklinks("Notes", documents);
    expect(backlinks).toEqual([{ fromId: "a", fromName: "Index.md" }]);
  });

  it("matches names case-insensitively without extensions", () => {
    const backlinks = computeBacklinks("index.md", documents);
    expect(backlinks).toEqual([{ fromId: "b", fromName: "Notes.md" }]);
  });

  it("never reports the document itself", () => {
    const backlinks = computeBacklinks("Other.md", [
      { id: "c", name: "Other.md", content: "[[Other]] self link" },
    ]);
    expect(backlinks).toEqual([]);
  });
});
