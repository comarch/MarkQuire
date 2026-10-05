import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, Extension, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import { TASK_LINE_PATTERN, toggleTaskLine } from "../../utils/tasks";

/**
 * Typora-style WYSIWYG overlay for the source editor.
 *
 * Replace decorations hide raw Markdown marks, mark decorations style the
 * text they wrap, and widgets render interactive or rich elements (bullet
 * glyphs, task checkboxes, horizontal rules, images, math), so authors see
 * formatted prose while the document keeps its exact Markdown bytes. Nothing
 * here mutates the document; every decoration derives from the Lezer
 * markdown tree plus the same $/$$ math rules the preview applies.
 *
 * The line(s) holding the cursor (selection heads and anchors) stay raw:
 * hidden delimiters must stay visible while being edited, exactly like
 * Typora revealing the current block. The reveal applies only while the
 * editor holds focus, so a loaded but untouched document renders fully.
 */

const boldMark = Decoration.mark({ class: "cm-rich-bold" });
const italicMark = Decoration.mark({ class: "cm-rich-italic" });
const strikeMark = Decoration.mark({ class: "cm-rich-strike" });
const codeMark = Decoration.mark({ class: "cm-rich-code" });
const linkTextMark = Decoration.mark({ class: "cm-rich-link-text" });
const codeLangMark = Decoration.mark({ class: "cm-rich-code-lang" });
const quoteLine = Decoration.line({ class: "cm-rich-quote" });
const codeLine = Decoration.line({ class: "cm-rich-code-line" });

const hide = (from: number, to: number): Range<Decoration> =>
  Decoration.replace({}).range(from, to);

const headingLines: Record<string, string> = {
  ATXHeading1: "cm-rich-h1",
  ATXHeading2: "cm-rich-h2",
  ATXHeading3: "cm-rich-h3",
  ATXHeading4: "cm-rich-h4",
  ATXHeading5: "cm-rich-h5",
  ATXHeading6: "cm-rich-h6",
};

// Bullet glyphs cycle with nesting depth, as rendered lists do.
const BULLET_GLYPHS = ["•", "◦", "▪", "•"];

// Only remote and data URIs may load in the editor; anything else keeps
// its raw Markdown form.
const SAFE_IMAGE_SRC = /^(?:https?:|data:image\/)/i;

// The image regex tolerates titles and spacing so the widget only needs
// the alt text and the raw URL.
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(\s*(\S+)(?:\s+["'][^"']*["'])?\s*\)$/;

// A task bullet token is unordered only in this form; ordered markers stay.
const UNORDERED_BULLET = /^[-*+]$/;

interface NodeLike {
  name: string;
  from: number;
  to: number;
  firstChild: NodeLike | null;
  lastChild: NodeLike | null;
  nextSibling: NodeLike | null;
  parent?: NodeLike | null;
}

const overlaps = (
  from: number,
  to: number,
  ranges: readonly { from: number; to: number }[],
): boolean => ranges.some((range) => from < range.to && to > range.from);

/** Line numbers the cursor edits: every selection head and anchor. */
export const activeLineNumbers = (state: EditorState): Set<number> => {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.head).number);
    lines.add(state.doc.lineAt(range.anchor).number);
  }
  return lines;
};

export class BulletWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }

  eq(other: BulletWidget): boolean {
    return other.char === this.char;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-rich-bullet";
    span.textContent = this.char;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly pos: number,
    readonly checked: boolean,
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.pos === this.pos && other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-rich-task-checkbox";
    box.setAttribute("aria-label", "Toggle task");
    // Preventing default keeps the editor cursor still while the click
    // rewrites the task marker through a normal undoable transaction.
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const line = view.state.doc.lineAt(this.pos);
      const next = toggleTaskLine(
        view.state.doc.toString(),
        line.number,
        !this.checked,
      );
      const nextLine = next.split("\n")[line.number - 1];
      if (nextLine === undefined || nextLine === line.text) return;
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: nextLine },
      });
    });
    return box;
  }
}

export class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const hr = document.createElement("span");
    hr.className = "cm-rich-hr";
    return hr;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM(): HTMLElement {
    // KaTeX output is its own escaped HTML; throwOnError renders invalid
    // input as red source text instead of failing the overlay.
    const html = katex.renderToString(this.tex, {
      displayMode: this.display,
      throwOnError: false,
    });
    const span = document.createElement("span");
    span.className = this.display
      ? "cm-rich-math cm-rich-math-display"
      : "cm-rich-math";
    span.innerHTML = html;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-rich-image-wrap";
    if (SAFE_IMAGE_SRC.test(this.src)) {
      const img = document.createElement("img");
      img.src = this.src;
      img.alt = this.alt;
      img.className = "cm-rich-image";
      img.loading = "lazy";
      wrap.appendChild(img);
    }
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface TaskSpan {
  bulletFrom: number;
  bulletTo: number;
  bracketFrom: number;
  checked: boolean;
}

/** Collects task-item spans for the given visible ranges. */
const collectTaskSpans = (
  state: EditorState,
  visible: readonly { from: number; to: number }[],
  isActive: (from: number, to: number) => boolean,
): Map<number, TaskSpan> => {
  // The syntax tree does not model GFM tasks, so the bracket widget is
  // placed from the same pattern the preview toggle uses.
  const spans = new Map<number, TaskSpan>();
  for (const { from, to } of visible) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      const task = TASK_LINE_PATTERN.exec(line.text);
      const prefix = task?.[1];
      if (prefix && task[2] !== undefined && !isActive(line.from, line.to)) {
        // Single character class: no alternation, no backtracking.
        const bulletIndex = prefix.search(/[-*+0-9]/);
        if (bulletIndex !== -1) {
          spans.set(line.number, {
            bulletFrom: line.from + bulletIndex,
            bulletTo: line.from + bulletIndex + 1,
            bracketFrom: line.from + prefix.length,
            checked: task[2] !== " ",
          });
        }
      }
      pos = line.to + 1;
    }
  }
  return spans;
};

// Hides the leading '#' marks of an ATX heading and tags the line with a
// heading class. Setext underlines stay visible to keep the source honest.
// Heading line classes always apply; only the mark hide yields to the
// active-line reveal.
const decorateHeading = (
  node: NodeLike,
  isActive: (from: number, to: number) => boolean,
  replaces: Range<Decoration>[],
  lines: Range<Decoration>[],
): void => {
  const mark = node.firstChild;
  if (mark?.name === "HeaderMark" && !isActive(mark.from, mark.to)) {
    replaces.push(hide(mark.from, mark.to));
  }
  const lineClass = headingLines[node.name];
  if (lineClass) {
    const lineFrom = node.from;
    lines.push(Decoration.line({ class: lineClass }).range(lineFrom, lineFrom));
  }
};

// Emphasis-like nodes put their delimiters in the first and last children.
// The whole node yields to the reveal so an edited line reads as raw text.
// Delimiter hides go to replaces; the style mark goes to marks, where it
// may legally overlap the hides of nested nodes (bold links, nested italics).
const decorateEmphasis = (
  node: NodeLike,
  style: Decoration,
  isActive: (from: number, to: number) => boolean,
  replaces: Range<Decoration>[],
  marks: Range<Decoration>[],
): void => {
  const first = node.firstChild;
  const last = node.lastChild;
  if (!first || !last) return;
  if (isActive(node.from, node.to)) return;
  replaces.push(hide(first.from, first.to));
  if (last !== first) {
    replaces.push(hide(last.from, last.to));
    if (first.to < last.from) {
      marks.push(style.range(first.to, last.from));
    }
  }
};

// Inline code hides its backticks and shows monospace text on a chip.
const decorateInlineCode = (
  node: NodeLike,
  isActive: (from: number, to: number) => boolean,
  replaces: Range<Decoration>[],
  marks: Range<Decoration>[],
): void => {
  if (isActive(node.from, node.to)) return;
  const first = node.firstChild;
  const last = node.lastChild;
  if (!first || !last) return;
  replaces.push(hide(first.from, first.to));
  if (last !== first) {
    replaces.push(hide(last.from, last.to));
    if (first.to < last.from) {
      marks.push(codeMark.range(first.to, last.from));
    }
  }
};

// Links show only the label, styled like a preview link. Inline links
// parse as Link { LinkMark "[", text, LinkMark "]", LinkMark "(", URL,
// LinkMark ")" }, so everything from the closing bracket on collapses.
// Autolinks (<...>) and images keep their source.
const decorateLink = (
  node: NodeLike,
  isActive: (from: number, to: number) => boolean,
  replaces: Range<Decoration>[],
  marks: Range<Decoration>[],
): void => {
  if (isActive(node.from, node.to)) return;
  const linkMarks: NodeLike[] = [];
  let child = node.firstChild;
  while (child) {
    if (child.name === "LinkMark") linkMarks.push(child);
    child = child.nextSibling;
  }
  if (linkMarks.length < 2 || !linkMarks[0] || !linkMarks[1]) return;
  const open = linkMarks[0];
  const close = linkMarks[1];
  replaces.push(hide(open.from, open.to), hide(close.from, node.to));
  if (open.to < close.from) {
    marks.push(linkTextMark.range(open.to, close.from));
  }
};

const decorateImage = (
  node: NodeLike,
  state: EditorState,
  isActive: (from: number, to: number) => boolean,
  replaces: Range<Decoration>[],
): void => {
  if (isActive(node.from, node.to)) return;
  const match = IMAGE_PATTERN.exec(state.sliceDoc(node.from, node.to));
  if (!match) return;
  const [, alt = "", src = ""] = match;
  if (!SAFE_IMAGE_SRC.test(src)) return;
  replaces.push(
    Decoration.replace({
      widget: new ImageWidget(src, alt),
    }).range(node.from, node.to),
  );
};

/**
 * Collects math widgets for the visible ranges. They follow the preview's
 * $ / $$ rules, stay out of code, and yield to the active-line reveal.
 * Single-line spans only: multiline display math would need block
 * widgets, so it keeps its raw source.
 */
const collectMathWidgets = (
  state: EditorState,
  visible: readonly { from: number; to: number }[],
  codeRanges: readonly { from: number; to: number }[],
  isActive: (from: number, to: number) => boolean,
  replaces: Range<Decoration>[],
): void => {
  for (const { from, to } of visible) {
    const text = state.sliceDoc(from, to);
    const mathRanges: { from: number; to: number }[] = [];
    const pushMath = (
      range: { from: number; to: number },
      tex: string,
      display: boolean,
    ): void => {
      if (!tex) return;
      if (isActive(range.from, range.to)) return;
      if (overlaps(range.from, range.to, codeRanges)) return;
      if (overlaps(range.from, range.to, mathRanges)) return;
      mathRanges.push(range);
      replaces.push(
        Decoration.replace({
          widget: new MathWidget(tex, display),
        }).range(range.from, range.to),
      );
    };
    const displayMath = /\$\$([^$\n]+?)\$\$/g;
    for (const match of text.matchAll(displayMath)) {
      const at = match.index ?? 0;
      pushMath(
        { from: from + at, to: from + at + match[0].length },
        match[1] ?? "",
        true,
      );
    }
    const inlineMath = /(^|[^\\])\$([^$\n]+?)\$/g;
    for (const match of text.matchAll(inlineMath)) {
      const at = match.index ?? 0;
      const prefixLength = match[1]?.length ?? 0;
      pushMath(
        {
          from: from + at + prefixLength,
          to: from + at + match[0].length,
        },
        match[2] ?? "",
        false,
      );
    }
  }
};

// Hides a quote mark and tags its line with the quote class. The line
// class anchors at the line start so nested quote marks keep one class.
const decorateQuoteMark = (
  state: EditorState,
  node: NodeLike,
  isActive: (from: number, to: number) => boolean,
  replaces: Range<Decoration>[],
  lines: Range<Decoration>[],
): void => {
  if (!isActive(node.from, node.to)) {
    replaces.push(hide(node.from, node.to));
  }
  const lineFrom = state.doc.lineAt(node.from).from;
  lines.push(quoteLine.range(lineFrom, lineFrom));
};

// Tags the interior lines of a fenced code block so the code body reads
// as a highlighted block while the fence marks themselves collapse.
const decorateFenceInterior = (
  state: EditorState,
  node: NodeLike,
  lines: Range<Decoration>[],
): void => {
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  for (let n = first.number + 1; n < last.number; n += 1) {
    const inner = state.doc.line(n);
    lines.push(codeLine.range(inner.from, inner.from));
  }
};

// Replaces an unordered list marker with a bullet glyph widget. Task
// lines get their widgets from decorateTaskLines; ordered markers stay.
const decorateListMark = (
  state: EditorState,
  node: NodeLike,
  taskSpans: ReadonlyMap<number, TaskSpan>,
  isActive: (from: number, to: number) => boolean,
  bulletDepth: number,
  replaces: Range<Decoration>[],
): void => {
  if (taskSpans.has(state.doc.lineAt(node.from).number)) return;
  if (node.parent?.parent?.name !== "BulletList") return;
  if (isActive(node.from, node.to)) return;
  const glyph =
    BULLET_GLYPHS[Math.min(bulletDepth - 1, BULLET_GLYPHS.length - 1)] ?? "•";
  replaces.push(
    Decoration.replace({
      widget: new BulletWidget(glyph),
    }).range(node.from, node.to),
  );
};

// Task lines get the checkbox widget on the bracket span and a bullet
// glyph on the raw bullet token when the marker is unordered. Task-like
// lines inside fenced code keep their raw source: the preview toggle
// skips fences too, so a widget there would be inert.
const decorateTaskLines = (
  state: EditorState,
  taskSpans: ReadonlyMap<number, TaskSpan>,
  codeRanges: readonly { from: number; to: number }[],
  replaces: Range<Decoration>[],
): void => {
  for (const span of taskSpans.values()) {
    // Only the bracket span decides: it can never sit inside inline code
    // (a task line with `code` further out keeps its widgets) but it is
    // inside fenced code, where the widgets would be inert.
    if (overlaps(span.bracketFrom, span.bracketFrom + 3, codeRanges)) continue;
    if (UNORDERED_BULLET.test(state.sliceDoc(span.bulletFrom, span.bulletTo))) {
      replaces.push(
        Decoration.replace({
          widget: new BulletWidget(BULLET_GLYPHS[0] ?? "•"),
        }).range(span.bulletFrom, span.bulletTo),
      );
    }
    replaces.push(
      Decoration.replace({
        widget: new TaskCheckboxWidget(span.bulletFrom, span.checked),
      }).range(span.bracketFrom, span.bracketFrom + 3),
    );
  }
};

// Replace decorations must not overlap: keep the earliest longest span
// and drop the rest so widgets compose instead of colliding. Mark and
// line decorations are allowed to overlap and stay out of this filter.
const dedupeReplaces = (
  replaces: readonly Range<Decoration>[],
): Range<Decoration>[] => {
  const sorted = [...replaces].sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: Range<Decoration>[] = [];
  let lastTo = -1;
  for (const candidate of sorted) {
    if (candidate.from >= lastTo) {
      kept.push(candidate);
      lastTo = candidate.to;
    }
  }
  return kept;
};

/**
 * Decoration sinks the syntax walk fills. Grouped as one object so the
 * walk keeps a small parameter list.
 */
interface DecorationSinks {
  replaces: Range<Decoration>[];
  marks: Range<Decoration>[];
  lines: Range<Decoration>[];
  // Code spans and fences: math and task widgets never render inside.
  codeRanges: { from: number; to: number }[];
}

/**
 * Walks the syntax tree over the visible ranges and dispatches every
 * node kind to its decorator. The switch stays flat: one case per node
 * name, each case a single call, so cognitive complexity stays low.
 */
const collectTreeDecorations = (
  state: EditorState,
  visible: readonly { from: number; to: number }[],
  isActive: (from: number, to: number) => boolean,
  taskSpans: ReadonlyMap<number, TaskSpan>,
  sinks: DecorationSinks,
): void => {
  const { replaces, marks, lines, codeRanges } = sinks;
  let bulletDepth = 0;
  for (const { from, to } of visible) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        const node = ref.node as unknown as NodeLike;
        switch (ref.name) {
          case "BulletList":
            bulletDepth += 1;
            break;
          case "ATXHeading1":
          case "ATXHeading2":
          case "ATXHeading3":
          case "ATXHeading4":
          case "ATXHeading5":
          case "ATXHeading6":
            decorateHeading(node, isActive, replaces, lines);
            break;
          case "StrongEmphasis":
            decorateEmphasis(node, boldMark, isActive, replaces, marks);
            break;
          case "Emphasis":
            decorateEmphasis(node, italicMark, isActive, replaces, marks);
            break;
          case "Strikethrough":
            decorateEmphasis(node, strikeMark, isActive, replaces, marks);
            break;
          case "InlineCode":
            decorateInlineCode(node, isActive, replaces, marks);
            codeRanges.push({ from: node.from, to: node.to });
            break;
          case "Link":
            decorateLink(node, isActive, replaces, marks);
            break;
          case "Image":
            decorateImage(node, state, isActive, replaces);
            break;
          case "QuoteMark":
            decorateQuoteMark(state, node, isActive, replaces, lines);
            break;
          case "FencedCode":
            codeRanges.push({ from: node.from, to: node.to });
            decorateFenceInterior(state, node, lines);
            break;
          case "CodeMark":
            if (!isActive(node.from, node.to)) {
              replaces.push(hide(node.from, node.to));
            }
            break;
          case "CodeInfo":
            if (!isActive(node.from, node.to)) {
              marks.push(codeLangMark.range(node.from, node.to));
            }
            break;
          case "ListMark":
            decorateListMark(
              state,
              node,
              taskSpans,
              isActive,
              bulletDepth,
              replaces,
            );
            break;
          case "HorizontalRule":
            if (!isActive(node.from, node.to)) {
              replaces.push(
                Decoration.replace({ widget: new HrWidget() }).range(
                  node.from,
                  node.to,
                ),
              );
            }
            break;
          default:
            break;
        }
      },
      leave: (ref) => {
        if (ref.name === "BulletList") bulletDepth -= 1;
      },
    });
  }
};

/**
 * Collects every rich-view decoration for the given visible ranges.
 * Exported so unit tests can drive it without a live EditorView.
 */
export const collectRichDecorations = (
  state: EditorState,
  visible: readonly { from: number; to: number }[],
  activeLines: ReadonlySet<number>,
): Range<Decoration>[] => {
  const activeRanges = [...activeLines].map((line) => state.doc.line(line));
  const isActive = (from: number, to: number): boolean =>
    activeRanges.some((range) => from <= range.to && to >= range.from);

  const taskSpans = collectTaskSpans(state, visible, isActive);

  const sinks: DecorationSinks = {
    replaces: [],
    marks: [],
    lines: [],
    codeRanges: [],
  };

  collectTreeDecorations(state, visible, isActive, taskSpans, sinks);
  collectMathWidgets(
    state,
    visible,
    sinks.codeRanges,
    isActive,
    sinks.replaces,
  );
  decorateTaskLines(state, taskSpans, sinks.codeRanges, sinks.replaces);

  return [...dedupeReplaces(sinks.replaces), ...sinks.marks, ...sinks.lines];
};

const richViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    focused: boolean;

    constructor(view: EditorView) {
      this.focused = view.hasFocus;
      this.decorations = this.build(view);
    }

    // The reveal applies only while the editor holds focus, so a loaded
    // but untouched document renders fully formatted.
    build(view: EditorView): DecorationSet {
      const active = this.focused
        ? activeLineNumbers(view.state)
        : new Set<number>();
      return Decoration.set(
        collectRichDecorations(view.state, view.visibleRanges, active),
        true,
      );
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged
      ) {
        this.focused = update.view.hasFocus;
        this.decorations = this.build(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

// Heading sizes are relative to the editor's configured font size, so the
// A-/A+ zoom keeps working in rich view.
const richViewTheme = EditorView.theme({
  ".cm-rich-bold": {
    fontWeight: "700",
  },
  ".cm-rich-italic": {
    fontStyle: "italic",
  },
  ".cm-rich-strike": {
    textDecoration: "line-through",
  },
  ".cm-rich-code": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    backgroundColor: "rgba(127, 127, 127, 0.15)",
    borderRadius: "3px",
    padding: "0.1em 0.25em",
    fontSize: "0.9em",
  },
  ".cm-rich-link-text": {
    color: "#0018CE",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  ".cm-rich-h1": {
    fontSize: "1.7em",
    fontWeight: "700",
    lineHeight: "1.3",
  },
  ".cm-rich-h2": {
    fontSize: "1.45em",
    fontWeight: "700",
    lineHeight: "1.3",
  },
  ".cm-rich-h3": {
    fontSize: "1.25em",
    fontWeight: "600",
    lineHeight: "1.35",
  },
  ".cm-rich-h4": {
    fontSize: "1.1em",
    fontWeight: "600",
  },
  ".cm-rich-h5": {
    fontWeight: "600",
  },
  ".cm-rich-h6": {
    fontWeight: "600",
    opacity: "0.9",
  },
  ".cm-rich-quote": {
    borderLeft: "3px solid rgba(127, 127, 127, 0.4)",
    paddingLeft: "0.75em",
    backgroundColor: "rgba(127, 127, 127, 0.06)",
  },
  ".cm-rich-code-line": {
    backgroundColor: "rgba(127, 127, 127, 0.1)",
  },
  ".cm-rich-code-lang": {
    opacity: "0.6",
    fontSize: "0.85em",
  },
  ".cm-rich-bullet": {
    color: "rgba(127, 127, 127, 0.9)",
    marginRight: "0.4em",
  },
  ".cm-rich-task-checkbox": {
    accentColor: "#0018CE",
    margin: "0 0.45em 0 0.15em",
    cursor: "pointer",
  },
  ".cm-rich-hr": {
    display: "block",
    height: "1px",
    borderTop: "1px solid rgba(127, 127, 127, 0.5)",
    margin: "0.8em 0",
  },
  ".cm-rich-math": {
    fontFamily: "var(--cl-font-family)",
  },
  ".cm-rich-math-display": {
    display: "block",
    textAlign: "center",
    margin: "0.3em 0",
  },
  ".cm-rich-image-wrap": {
    display: "inline-block",
    maxWidth: "100%",
  },
  ".cm-rich-image": {
    maxWidth: "100%",
    maxHeight: "200px",
    borderRadius: "4px",
    margin: "2px 0",
    display: "block",
  },
});

/**
 * Full WYSIWYG overlay: hidden marks, styled emphasis, links, inline code,
 * heading and quote line classes, bullet and task widgets, images,
 * horizontal rules, and KaTeX math. Mount only while the mode is on.
 */
export const richViewExtension: Extension = [richViewPlugin, richViewTheme];
