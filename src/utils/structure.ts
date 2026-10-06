import { frontmatterLineOffset } from "./frontmatter";

// Structure tools: section reordering, optional heading numbering, and
// generated tables of contents. All operations work on whole sections
// and produce one document rewrite, so the editor records a single
// undo step.

export interface Section {
  /** 1-based line of the heading. */
  headingLine: number;
  /** 1-based line of the last line in the section. */
  endLine: number;
  level: number;
  text: string;
}

interface HeadingMark {
  line: number;
  level: number;
  text: string;
}

const HEADING_PATTERN = /^(#{1,6})[ \t]+([^ \t\r\n\u2028\u2029].*)$/;
const NUMBERED_HEADING_PATTERN = /^(#{2,6})[ \t]+([^ \t\r\n\u2028\u2029].*)$/;

function isDigit(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function parseNumberedHeading(
  line: string,
): { hashes: string; existingNumber: string | null; text: string } | null {
  const match = NUMBERED_HEADING_PATTERN.exec(line);
  if (!match?.[1] || !match[2]) return null;
  const hashes = match[1];
  const text = match[2];

  let cursor = 0;
  const parts: string[] = [];
  while (true) {
    const start = cursor;
    while (isDigit(text[cursor])) cursor += 1;
    const digits = text.slice(start, cursor);
    if (digits.length === 0 || digits.length > 9) {
      return { hashes, existingNumber: null, text };
    }
    parts.push(digits);
    if (text[cursor] !== ".") {
      return { hashes, existingNumber: null, text };
    }
    cursor += 1;
    if (text[cursor] === " " || text[cursor] === "\t") {
      while (text[cursor] === " " || text[cursor] === "\t") {
        cursor += 1;
      }
      const remainder = text.slice(cursor);
      return remainder.length > 0
        ? { hashes, existingNumber: parts.join("."), text: remainder }
        : { hashes, existingNumber: null, text };
    }
    if (!isDigit(text[cursor])) {
      return { hashes, existingNumber: null, text };
    }
  }
}

function scanHeadings(lines: string[]): HeadingMark[] {
  const marks: HeadingMark[] = [];
  let fence: string | null = null;
  const skipUntil = frontmatterLineOffset(lines.join("\n"));

  // A line that opens, closes, or sits inside a code fence is never a
  // heading; the fence marker is tracked across lines.
  const isCodeFence = (trimmed: string): boolean => {
    if (fence === null) {
      if (/^(```|~~~)/.test(trimmed)) {
        fence = trimmed.slice(0, 3);
        return true;
      }
      return false;
    }
    if (trimmed.startsWith(fence)) fence = null;
    return true;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isCodeFence(line.trimStart())) continue;
    if (index < skipUntil) continue;
    const heading = HEADING_PATTERN.exec(line);
    if (!heading?.[1] || !heading[2]) continue;
    marks.push({
      line: index + 1,
      level: heading[1].length,
      text: heading[2].trim(),
    });
  }

  return marks;
}

/**
 * Splits the document into heading-led sections. A section runs from its
 * heading to just before the next heading of the same or shallower
 * level; deeper headings belong to the enclosing section.
 */
export function extractSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const marks = scanHeadings(lines);

  return marks.map((mark, index) => {
    let endLine = lines.length;
    for (let next = index + 1; next < marks.length; next += 1) {
      const candidate = marks[next];
      if (candidate && candidate.level <= mark.level) {
        endLine = candidate.line - 1;
        break;
      }
    }
    return {
      headingLine: mark.line,
      endLine,
      level: mark.level,
      text: mark.text,
    };
  });
}

function sectionAt(sections: Section[], headingLine: number): Section | null {
  return (
    sections.find((section) => section.headingLine === headingLine) ?? null
  );
}

/**
 * Moves the section starting at the given heading line among its
 * same-level siblings. offset -1 swaps with the previous sibling,
 * +1 with the next. Returns the input unchanged when there is no
 * sibling to swap with.
 */
export function moveSectionBy(
  markdown: string,
  headingLine: number,
  offset: -1 | 1,
): string {
  const sections = extractSections(markdown);
  const target = sectionAt(sections, headingLine);
  if (!target) return markdown;

  const siblings = sections.filter((s) => s.level === target.level);
  const targetIndex = siblings.findIndex(
    (s) => s.headingLine === target.headingLine,
  );
  const neighbor = siblings[targetIndex + offset];
  if (!neighbor) return markdown;

  // Swap the two sibling ranges, keeping everything else in place.
  const lines = markdown.split("\n");
  const before = lines.slice(
    0,
    Math.min(target.headingLine, neighbor.headingLine) - 1,
  );
  const after = lines.slice(Math.max(target.endLine, neighbor.endLine));
  const first =
    offset === -1
      ? lines.slice(target.headingLine - 1, target.endLine)
      : lines.slice(neighbor.headingLine - 1, neighbor.endLine);
  const second =
    offset === -1
      ? lines.slice(neighbor.headingLine - 1, neighbor.endLine)
      : lines.slice(target.headingLine - 1, target.endLine);

  return [...before, ...first, ...second, ...after].join("\n");
}

/**
 * Adds or removes sequential numbering on level 2+ headings. H1 stays
 * unnumbered as the document title. Toggling off strips only generated
 * leading numbers, never other heading text.
 */
export function numberHeadings(markdown: string, enabled: boolean): string {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  const skipUntil = frontmatterLineOffset(markdown);
  const counters: number[] = [];

  return lines
    .map((line, index) => {
      const trimmed = line.trimStart();
      if (fence === null) {
        if (/^(```|~~~)/.test(trimmed)) {
          fence = trimmed.slice(0, 3);
          return line;
        }
      } else {
        if (trimmed.startsWith(fence)) fence = null;
        return line;
      }
      if (index < skipUntil) return line;

      const heading = parseNumberedHeading(line);
      if (!heading) return line;
      const { hashes, existingNumber, text } = heading;
      const level = hashes.length;

      if (!enabled) {
        // Remove only a generated number; keep user text intact.
        return existingNumber ? `${hashes} ${text}` : line;
      }

      const depth = level - 1;
      // Truncate only the deeper levels; the counter at this depth
      // keeps counting across siblings.
      counters.length = depth + 1;
      counters[depth] = (counters[depth] ?? 0) + 1;
      // The H1 title is unnumbered, so the first number component is
      // the level-2 counter at depth 1.
      const number = counters.slice(1, depth + 1).join(".");
      return `${hashes} ${number}. ${text}`;
    })
    .join("\n");
}

/**
 * Builds a Markdown table of contents linking to the preview anchors,
 * for headings of level 2 and deeper.
 */
export function generateTableOfContents(markdown: string): string {
  const sections = extractSections(markdown).filter((s) => s.level >= 2);
  if (sections.length === 0) return "";

  return sections
    .map((section) => {
      const indent = "  ".repeat(Math.max(0, section.level - 2));
      const anchor = encodeURIComponent(
        section.text
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-"),
      );
      return `${indent}- [${section.text}](#${anchor})`;
    })
    .join("\n");
}
