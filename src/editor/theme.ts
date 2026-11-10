// Theme plumbing. All colours live in editor.css as CSS variables, so a theme flip needs
// no extension rebuild. The only theme-aware output is Mermaid's SVG, handled here.
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { classHighlighter, highlightTree } from "@lezer/highlight";

export const editorRootClass = EditorView.editorAttributes.of({ class: "notepadly-cm" });

const tokenMarks = new Map<string, Decoration>();
function tokenMark(className: string): Decoration {
  let mark = tokenMarks.get(className);
  if (!mark) {
    mark = Decoration.mark({ class: className });
    tokenMarks.set(className, mark);
  }
  return mark;
}

/**
 * Token classes for the visible ranges. CodeMirror's stock highlighter steps through every
 * top-level sibling before the viewport, which in a long Markdown file costs tens of
 * milliseconds per keystroke. This seeks the overlapping top-level nodes in log time and
 * highlights only those.
 */
function buildTokens(view: EditorView): DecorationSet {
  const tree = syntaxTree(view.state);
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.type.isTop) return true;
        const subtree = node.tree;
        if (subtree) {
          const offset = node.from;
          highlightTree(
            subtree,
            classHighlighter,
            (start, end, className) => ranges.push(tokenMark(className).range(start + offset, end + offset)),
            Math.max(0, from - offset),
            Math.min(subtree.length, to - offset),
          );
        }
        return false;
      },
    });
  }
  return Decoration.set(ranges, true);
}

export const tokenClasses = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildTokens(view);
    }
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildTokens(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const RTL_TEXT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const MAX_DIRECTION_LINE = 20000;
const autoDirection = Decoration.line({ attributes: { dir: "auto" } });

function buildDirections(view: EditorView): DecorationSet {
  const { doc } = view.state;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    if (!RTL_TEXT.test(doc.sliceString(from, to))) continue;
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      if (line.length <= MAX_DIRECTION_LINE && RTL_TEXT.test(line.text)) {
        ranges.push(autoDirection.range(line.from));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges);
}

/**
 * `perLineTextDirection` only reads each line's direction, so lines holding RTL text
 * need `dir="auto"` to get one. Only visible lines are touched.
 */
export const lineDirections = [
  EditorView.perLineTextDirection.of(true),
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDirections(view);
      }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) this.decorations = buildDirections(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
];

function luminanceOf(color: string): number | null {
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  if (parts.length >= 4 && Number(parts[3]) === 0) return null;
  const [r, g, b] = parts.map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function detectDark(root: HTMLElement): boolean {
  for (let el: HTMLElement | null = root; el; el = el.parentElement) {
    const luminance = luminanceOf(getComputedStyle(el).backgroundColor);
    if (luminance !== null) return luminance < 128;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

let dark = false;

export function isDarkTheme(): boolean {
  return dark;
}

/** Watches for theme changes however the app applies them; returns a disposer. */
export function watchTheme(root: HTMLElement, onChange: () => void): () => void {
  dark = detectDark(root);
  let frame = 0;
  const check = () => {
    frame = 0;
    const next = detectDark(root);
    if (next !== dark) {
      dark = next;
      onChange();
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(check);
  };
  const observer = new MutationObserver(schedule);
  const options = { attributes: true, attributeFilter: ["class", "style", "data-theme"] };
  observer.observe(document.documentElement, options);
  if (document.body) observer.observe(document.body, options);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", schedule);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
