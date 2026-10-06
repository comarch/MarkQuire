import { parseFrontmatter } from "./frontmatter";

// Slide mode: a document becomes a deck. Slides split on thematic
// breaks (---) outside code fences; without any break, level-2
// headings become slide boundaries.

// Shared line splitter: walks code fences and cuts a new chunk on every
// boundary line, keeping the boundary line itself only when asked.
function splitMarkdownLines(
  lines: string[],
  isBoundary: (line: string, trimmed: string) => boolean,
  keepBoundary: boolean,
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = (): void => {
    const text = current.join("\n").trim();
    if (text.length > 0) chunks.push(text);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (fence === null) {
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        fence = trimmed.slice(0, 3);
        current.push(line);
        continue;
      }
    } else {
      if (trimmed.startsWith(fence)) fence = null;
      current.push(line);
      continue;
    }

    if (isBoundary(line, trimmed)) {
      flush();
      if (keepBoundary) current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return chunks;
}

/** Splits markdown into presentation slides. */
export function splitSlides(markdown: string): string[] {
  const { body } = parseFrontmatter(markdown);
  // A thematic break alone on its line ends the slide and is dropped.
  const slides = splitMarkdownLines(
    body.split("\n"),
    (_line, trimmed) => /^(---|\*\*\*|___)$/.test(trimmed),
    false,
  );

  // No breaks at all: fall back to level-2 heading boundaries, where the
  // heading starts the next slide.
  if (slides.length <= 1) {
    const byHeading = splitByHeadings(body);
    if (byHeading.length > 1) return byHeading;
  }

  if (slides.length === 0 && body.trim().length > 0) {
    return [body.trim()];
  }
  return slides;
}

function splitByHeadings(body: string): string[] {
  return splitMarkdownLines(
    body.split("\n"),
    (line) => /^##[ \t]+/.test(line),
    true,
  );
}

const HEADING_TITLE_PATTERN = /^#{1,6}[ \t]+([^ \t\r\n\u2028\u2029].*)$/;

/** First heading or non-empty line of a slide, for the agenda list. */
export function slideTitle(slide: string): string {
  const heading = slide
    .split("\n")
    .map((line) => HEADING_TITLE_PATTERN.exec(line.trim()))
    .find(Boolean);
  const fromHeading = heading?.[1]?.trim();
  if (fromHeading) return fromHeading;
  const firstText = slide
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("```"));
  return firstText?.slice(0, 60) ?? "Slide";
}
