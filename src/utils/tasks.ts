// Blockquote markers are allowed so quoted task lists map to their source
// line the same way the renderer shows them.
export const TASK_LINE_PATTERN =
  /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\][ \t]+/;

function isFenceLine(line: string): boolean {
  const trimmed = line.trim();
  // CommonMark fences use backticks or tildes; the util must skip both or
  // its line numbers drift from what the renderer actually shows.
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

export function findTaskListLines(markdownText: string): number[] {
  const lines = markdownText.split("\n");
  const taskLines: number[] = [];
  let inFence = false;

  lines.forEach((line, index) => {
    if (isFenceLine(line)) {
      inFence = !inFence;
      return;
    }

    if (!inFence && TASK_LINE_PATTERN.test(line)) {
      taskLines.push(index + 1);
    }
  });

  return taskLines;
}

export function toggleTaskLine(
  markdownText: string,
  lineNumber: number,
  checked: boolean,
): string {
  const lines = markdownText.split("\n");
  if (
    !Number.isInteger(lineNumber) ||
    lineNumber < 1 ||
    lineNumber > lines.length
  ) {
    return markdownText;
  }

  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) return markdownText;

    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }

    if (inFence || index !== lineNumber - 1) continue;

    const match = TASK_LINE_PATTERN.exec(line);
    const prefix = match?.[1];
    const currentMarker = match?.[2];
    if (!prefix || currentMarker === undefined) return markdownText;

    if (
      (checked && currentMarker.toLowerCase() === "x") ||
      (!checked && currentMarker === " ")
    ) {
      return markdownText;
    }

    const checkboxStart = prefix.length;
    lines[index] =
      line.slice(0, checkboxStart) +
      `[${checked ? "x" : " "}]` +
      line.slice(checkboxStart + 3);
    return lines.join("\n");
  }

  return markdownText;
}
