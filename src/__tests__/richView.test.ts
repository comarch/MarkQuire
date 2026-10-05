import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  BulletWidget,
  HrWidget,
  ImageWidget,
  MathWidget,
  TaskCheckboxWidget,
  activeLineNumbers,
  collectRichDecorations,
} from "../components/Editor/richView";

// The overlay is a pure function of the parsed document and the active
// lines, so every widget and reveal rule is testable without a mounted
// EditorView.

const makeState = (doc: string, cursor = 0): EditorState =>
  EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage })],
  });

interface FoundDecoration {
  from: number;
  to: number;
  className?: string;
  widget?: unknown;
  isLine: boolean;
}

const collect = (state: EditorState, active?: Set<number>) =>
  collectRichDecorations(
    state,
    [{ from: 0, to: state.doc.length }],
    active ?? activeLineNumbers(state),
  );

const inspect = (ranges: Range<Decoration>[]): FoundDecoration[] =>
  ranges.map((range) => {
    const spec = range.value.spec as {
      class?: string;
      widget?: unknown;
    };
    return {
      from: range.from,
      to: range.to,
      className: spec.class,
      widget: spec.widget,
      isLine: range.from === range.to,
    };
  });

const widgetInstances = <T>(
  decorations: FoundDecoration[],
  type: new (...args: never[]) => T,
): { found: FoundDecoration; widget: T }[] =>
  decorations
    .filter((item) => item.widget instanceof type)
    .map((item) => ({
      found: item,
      widget: item.widget as T,
    }));

const classNames = (decorations: FoundDecoration[], name: string): number =>
  decorations.filter(
    (item) => item.className?.split(" ").includes(name) === true,
  ).length;

describe("rich view decorations", () => {
  it("hides heading marks and keeps the heading line class", () => {
    const state = makeState("# Title\n\nBody\n", 8);
    const decorations = inspect(collect(state));

    // The ATX HeaderMark covers only the '#' characters.
    expect(decorations).toContainEqual(
      expect.objectContaining({ from: 0, to: 1 }),
    );
    expect(classNames(decorations, "cm-rich-h1")).toBe(1);
  });

  it("keeps heading marks visible on the active line", () => {
    const state = makeState("# Title\n\nBody\n", 0);
    const decorations = inspect(collect(state));

    expect(decorations.some((item) => item.from === 0 && item.to === 1)).toBe(
      false,
    );
    expect(classNames(decorations, "cm-rich-h1")).toBe(1);
  });

  it("renders everything when the editor is not focused", () => {
    const state = makeState("# Title\n\n**bold**\n");
    const decorations = inspect(collect(state, new Set<number>()));

    expect(decorations.some((item) => item.from === 0 && item.to === 1)).toBe(
      true,
    );
    expect(classNames(decorations, "cm-rich-bold")).toBe(1);
  });

  it("hides emphasis delimiters and styles the wrapped text", () => {
    const doc = "plain\n\n**bold** and *ital* and ~~gone~~ and `code`\n";
    const state = makeState(doc, 0);
    const decorations = inspect(collect(state));

    expect(classNames(decorations, "cm-rich-bold")).toBe(1);
    expect(classNames(decorations, "cm-rich-italic")).toBe(1);
    expect(classNames(decorations, "cm-rich-strike")).toBe(1);
    expect(classNames(decorations, "cm-rich-code")).toBe(1);

    // Hidden delimiter pairs collapse: 2 per emphasis node plus the
    // inline-code backticks.
    const hides = decorations.filter(
      (item) =>
        item.widget === undefined &&
        !item.isLine &&
        item.className === undefined,
    );
    expect(hides.length).toBe(8);
  });

  it("reveals raw emphasis while the cursor edits that line", () => {
    const doc = "intro\n\n**bold** words\n";
    const state = makeState(doc, doc.indexOf("bold"));
    const decorations = inspect(collect(state));

    expect(classNames(decorations, "cm-rich-bold")).toBe(0);
    expect(
      decorations.some(
        (item) => item.from === doc.indexOf("**") && item.to > item.from,
      ),
    ).toBe(false);
  });

  it("shows link labels only", () => {
    const doc = "intro\n\nSee [the docs](https://example.invalid/guide) now\n";
    const state = makeState(doc, 0);
    const decorations = inspect(collect(state));

    expect(classNames(decorations, "cm-rich-link-text")).toBe(1);
    // The "[", "](url)" collapses to two hides.
    const hides = decorations.filter(
      (item) =>
        item.widget === undefined &&
        !item.isLine &&
        item.className === undefined,
    );
    expect(hides.length).toBe(2);
  });

  it("hides blockquote marks and styles quoted lines", () => {
    const doc = "text\n\n> quoted line\n";
    const state = makeState(doc, 0);
    const decorations = inspect(collect(state));

    expect(classNames(decorations, "cm-rich-quote")).toBe(1);
    const quoteMarkFrom = doc.indexOf(">");
    expect(
      decorations.some(
        (item) => item.from === quoteMarkFrom && item.to === quoteMarkFrom + 1,
      ),
    ).toBe(true);
  });

  it("renders unordered list bullets as glyph widgets", () => {
    const doc = "- one\n- two\nplain\n";
    const state = makeState(doc, doc.length - 1);
    const decorations = inspect(collect(state));
    const bullets = widgetInstances(decorations, BulletWidget);

    expect(bullets.length).toBe(2);
    expect(bullets[0]?.widget.char).toBe("•");
    expect(bullets[0]?.found.from).toBe(0);
  });

  it("keeps ordered list markers raw", () => {
    const state = makeState("1. first\n2. second\n", 0);
    const decorations = inspect(collect(state));

    expect(widgetInstances(decorations, BulletWidget).length).toBe(0);
  });

  it("renders task checkboxes for both task states", () => {
    const doc = "- [ ] open item\n- [x] done item\nplain\n";
    const state = makeState(doc, doc.length - 1);
    const decorations = inspect(collect(state));
    const tasks = widgetInstances(decorations, TaskCheckboxWidget);

    expect(tasks.length).toBe(2);
    expect(tasks[0]?.widget.checked).toBe(false);
    expect(tasks[1]?.widget.checked).toBe(true);
    expect(tasks[0]?.found.from).toBe(doc.indexOf("[ ]"));
    expect(tasks[0]?.found.to).toBe(doc.indexOf("[ ]") + 3);
  });

  it("keeps task lines raw while the cursor edits them", () => {
    const doc = "- [ ] open item\nplain\n";
    const state = makeState(doc, doc.indexOf("open"));
    const decorations = inspect(collect(state));

    expect(widgetInstances(decorations, TaskCheckboxWidget).length).toBe(0);
  });

  it("hides code fence marks and tags interior lines", () => {
    const doc = "intro\n\n```js\nconst a = 1;\n```\n";
    const state = makeState(doc, 0);
    const decorations = inspect(collect(state));

    expect(classNames(decorations, "cm-rich-code-lang")).toBe(1);
    expect(classNames(decorations, "cm-rich-code-line")).toBe(1);
    const fenceAt = doc.indexOf("```");
    const fenceEnd = doc.indexOf("```", fenceAt + 3);
    const fenceHides = decorations.filter(
      (item) =>
        item.widget === undefined &&
        item.className === undefined &&
        !item.isLine &&
        item.from >= fenceAt &&
        item.to <= fenceEnd + 3,
    );
    expect(fenceHides.length).toBe(2);
  });

  it("renders horizontal rules as widgets but never setext underlines", () => {
    const doc = "intro\n\n---\n\nSetext\n===\n";
    const state = makeState(doc, 0);
    const decorations = inspect(collect(state));

    const rules = widgetInstances(decorations, HrWidget);
    expect(rules.length).toBe(1);
    expect(rules[0]?.found.from).toBe(doc.indexOf("---"));
  });

  it("renders safe images and rejects unsafe sources", () => {
    const doc =
      "intro\n\n![pic](https://example.invalid/a.png) and ![x](javascript:alert(1))\n";
    const state = makeState(doc, 0);
    const decorations = inspect(collect(state));
    const images = widgetInstances(decorations, ImageWidget);

    expect(images.length).toBe(1);
    expect(images[0]?.widget.src).toBe("https://example.invalid/a.png");
    expect(images[0]?.widget.alt).toBe("pic");
  });

  it("renders inline and display math with the preview rules", () => {
    const doc =
      "intro\n\nEuler wrote $e^{i\\pi} + 1 = 0$ here\n\n$$c^2 = a^2 + b^2$$\n";
    const state = makeState(doc, 0);
    const decorations = inspect(collect(state));
    const math = widgetInstances(decorations, MathWidget);

    expect(math.length).toBe(2);
    expect(math[0]?.widget.display).toBe(false);
    expect(math[0]?.widget.tex).toBe("e^{i\\pi} + 1 = 0");
    expect(math[1]?.widget.display).toBe(true);
  });

  it("treats a lone dollar sign as currency, not math", () => {
    const state = makeState("costs $5 today\n", 0);
    const decorations = inspect(collect(state));

    expect(widgetInstances(decorations, MathWidget).length).toBe(0);
  });

  it("never renders math inside code spans", () => {
    const state = makeState("use `$x$` inline\n", 0);
    const decorations = inspect(collect(state));

    expect(widgetInstances(decorations, MathWidget).length).toBe(0);
  });

  it("reveals raw math while the cursor edits that line", () => {
    const doc = "value $x^2$ end\n";
    const state = makeState(doc, doc.indexOf("x"));
    const decorations = inspect(collect(state));

    expect(widgetInstances(decorations, MathWidget).length).toBe(0);
  });
});
