// Block widgets (tables, math, Mermaid, rules, folded callouts).
//
// CodeMirror requires these to come from a StateField. The field never walks the whole
// tree: it maps known blocks through changes and rescans only the padded viewport, which
// a ViewPlugin reports through an effect. Blocks outside that window keep their mapped
// decorations, so scrolled-away widgets retain their height.
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Range,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isDarkTheme } from "../theme";
import { HorizontalRuleWidget, MathWidget, MermaidWidget, TableWidget } from "./widgets";

/** Characters scanned on each side of the reported viewport. */
const SCAN_PADDING = 4000;

interface Span {
  from: number;
  to: number;
}

export const setBlockViewport = StateEffect.define<Span>({
  map: (value, changes) => ({ from: changes.mapPos(value.from), to: changes.mapPos(value.to) }),
});
export const rebuildBlocks = StateEffect.define<null>();
/**
 * Opens the source of a rendered block (math, Mermaid, rule) at this position. Such blocks
 * never reveal just because the cursor touches them; only this effect (double-click or the
 * edit button) shows their source, until the selection leaves the block.
 */
export const openBlockSource = StateEffect.define<number>({
  map: (pos, changes) => changes.mapPos(pos),
});
export const toggleCalloutFold = StateEffect.define<number>({
  map: (pos, changes) => changes.mapPos(pos),
});

export const CALLOUT_LINE = /^\s*((?:>\s?)+)\[!([\w-]+)\]([-+]?)[ \t]*(.*)$/;

interface Revealed extends Span {
  deco: Decoration;
}

interface BlockValue {
  /** Every known block decoration, including those currently revealed as source. */
  blocks: DecorationSet;
  /** The subset drawn: `blocks` minus anything the selection touches. */
  shown: DecorationSet;
  revealed: readonly Revealed[];
  scanned: Span;
  /** Callouts whose fold state was flipped from the default in their marker. */
  toggled: readonly number[];
  /** Start of the block whose source was opened explicitly, if any. */
  editing: number | null;
}

/**
 * How a block reacts to the selection:
 * - "touch" (default): source shows while the selection touches it (folded callouts).
 * - "explicit": source shows only after `openBlockSource` (math, Mermaid, rules).
 * - "never": always rendered; the widget edits the document itself (tables).
 */
type RevealMode = "touch" | "explicit" | "never";

function isTouched(
  from: number,
  to: number,
  deco: Decoration,
  selection: EditorSelection,
  editing: number | null,
): boolean {
  const mode = (deco.spec.reveal as RevealMode | undefined) ?? "touch";
  if (mode === "never") return false;
  if (mode === "explicit" && editing !== from) return false;
  const start = (deco.spec.revealFrom as number | undefined) ?? 0;
  const lower = from + start;
  return selection.ranges.some((range) => range.from <= to && range.to >= lower);
}

function paddedSpan(view: Span, length: number): Span {
  return { from: Math.max(0, view.from - SCAN_PADDING), to: Math.min(length, view.to + SCAN_PADDING) };
}

function collectBlocks(state: EditorState, span: Span, toggled: readonly number[]): Range<Decoration>[] {
  const found: Range<Decoration>[] = [];
  const { doc } = state;
  syntaxTree(state).iterate({
    from: span.from,
    to: span.to,
    enter: (node) => {
      if (node.name === "Document") return true;
      const startLine = doc.lineAt(node.from);
      const endLine = doc.lineAt(node.to);
      const replace = (widget: Decoration["spec"]["widget"], reveal: RevealMode = "explicit") =>
        found.push(Decoration.replace({ widget, block: true, reveal }).range(startLine.from, endLine.to));

      switch (node.name) {
        case "Table":
          replace(new TableWidget(doc.sliceString(startLine.from, endLine.to)), "never");
          break;
        case "HorizontalRule":
          if (startLine.number === endLine.number) replace(new HorizontalRuleWidget());
          break;
        case "BlockMath": {
          const marks = node.node.getChildren("MathMark");
          if (marks.length === 2) {
            const text = doc.sliceString(marks[0].to, marks[1].from).trim();
            replace(new MathWidget(text, true, marks[0].to - startLine.from));
          }
          break;
        }
        case "FencedCode": {
          const info = node.node.getChild("CodeInfo");
          if (info && doc.sliceString(info.from, info.to).toLowerCase() === "mermaid") {
            const body = node.node.getChild("CodeText");
            const fences = node.node.getChildren("CodeMark");
            if (body && fences.length === 2) {
              replace(
                new MermaidWidget(doc.sliceString(body.from, body.to), isDarkTheme(), body.from - startLine.from),
              );
            }
          }
          break;
        }
        case "Blockquote": {
          if (endLine.number > startLine.number) {
            const match = CALLOUT_LINE.exec(startLine.text);
            if (match && isCalloutFolded(toggled, startLine.from, match[3])) {
              found.push(
                Decoration.replace({ revealFrom: 1 }).range(startLine.to, endLine.to),
              );
            }
          }
          break;
        }
      }
      return false;
    },
  });
  return found;
}

function isCalloutFolded(toggled: readonly number[], from: number, marker: string): boolean {
  return (marker === "-") !== toggled.includes(from);
}

export function calloutFolded(state: EditorState, from: number, marker: string): boolean {
  return isCalloutFolded(state.field(blockField).toggled, from, marker);
}

function scan(value: BlockValue, state: EditorState, span: Span): BlockValue {
  const parsedTo = Math.min(span.to, syntaxTree(state).length);
  if (parsedTo < span.from) return { ...value, scanned: span };
  const found = collectBlocks(state, { from: span.from, to: parsedTo }, value.toggled);
  const remove = { filterFrom: span.from, filterTo: parsedTo, filter: () => false };
  const hasSelectionHit = (range: Range<Decoration>) =>
    isTouched(range.from, range.to, range.value, state.selection, value.editing);
  return {
    ...value,
    blocks: value.blocks.update({ ...remove, add: found }),
    shown: value.shown.update({ ...remove, add: found.filter((range) => !hasSelectionHit(range)) }),
    revealed: value.revealed.filter((item) => item.to < span.from || item.from > parsedTo),
    scanned: span,
  };
}

/** Applies reveal changes by touching only the blocks entering or leaving the selection. */
function applyReveal(value: BlockValue, state: EditorState): BlockValue {
  const { selection } = state;
  const now: Revealed[] = [];
  for (const range of selection.ranges) {
    value.blocks.between(Math.max(0, range.from - 1), range.to + 1, (from, to, deco) => {
      if (isTouched(from, to, deco, selection, value.editing) && !now.some((item) => item.deco === deco)) {
        now.push({ from, to, deco });
      }
    });
  }
  const leaving = value.revealed.filter((item) => !now.some((other) => other.deco === item.deco));
  const entering = now.filter((item) => !value.revealed.some((other) => other.deco === item.deco));
  if (!leaving.length && !entering.length) {
    return now.length === value.revealed.length ? value : { ...value, revealed: now };
  }
  const hide = new Set(entering.map((item) => item.deco));
  const positions = [...leaving, ...entering];
  return {
    ...value,
    revealed: now,
    shown: value.shown.update({
      add: leaving.map((item) => item.deco.range(item.from, item.to)),
      sort: true,
      filterFrom: Math.min(...positions.map((item) => item.from)),
      filterTo: Math.max(...positions.map((item) => item.to)),
      filter: (_from, _to, deco) => !hide.has(deco),
    }),
  };
}

function mapValue(value: BlockValue, tr: Transaction): BlockValue {
  const { changes } = tr;
  return {
    blocks: value.blocks.map(changes),
    shown: value.shown.map(changes),
    revealed: value.revealed.map((item) => ({
      from: changes.mapPos(item.from, 1),
      to: changes.mapPos(item.to, -1),
      deco: item.deco,
    })),
    scanned: { from: changes.mapPos(value.scanned.from), to: changes.mapPos(value.scanned.to) },
    toggled: value.toggled.map((pos) => changes.mapPos(pos)),
    editing: value.editing === null ? null : changes.mapPos(value.editing, 1),
  };
}

/** Closes an explicitly opened block once the selection no longer touches it. */
function closeEditing(value: BlockValue, state: EditorState): BlockValue {
  if (value.editing === null) return value;
  const pos = value.editing;
  let inside = false;
  value.blocks.between(pos, pos, (from, to) => {
    if (from !== pos) return;
    inside = state.selection.ranges.some((range) => range.from <= to && range.to >= from);
  });
  return inside ? value : { ...value, editing: null };
}

function initialValue(state: EditorState): BlockValue {
  const empty: BlockValue = {
    blocks: Decoration.none,
    shown: Decoration.none,
    revealed: [],
    scanned: { from: 0, to: 0 },
    toggled: [],
    editing: null,
  };
  return applyReveal(
    scan(empty, state, paddedSpan({ from: 0, to: Math.min(state.doc.length, 16000) }, state.doc.length)),
    state,
  );
}

export const blockField = StateField.define<BlockValue>({
  create: initialValue,
  update(value, tr) {
    let next = tr.docChanged ? mapValue(value, tr) : value;
    let span: Span | null = tr.docChanged ? next.scanned : null;
    let opened = false;

    const oldTree = syntaxTree(tr.startState);
    const newTree = syntaxTree(tr.state);
    if (!span && newTree !== oldTree && oldTree.length < next.scanned.to) span = next.scanned;

    for (const effect of tr.effects) {
      if (effect.is(setBlockViewport)) {
        span = paddedSpan(effect.value, tr.state.doc.length);
      } else if (effect.is(rebuildBlocks)) {
        span = next.scanned;
      } else if (effect.is(toggleCalloutFold)) {
        const pos = effect.value;
        next = {
          ...next,
          toggled: next.toggled.includes(pos)
            ? next.toggled.filter((item) => item !== pos)
            : [...next.toggled, pos],
        };
        span = next.scanned;
      } else if (effect.is(openBlockSource)) {
        next = { ...next, editing: effect.value };
        opened = true;
      }
    }
    if (span) next = scan(next, tr.state, span);
    if (!opened && (tr.selection || tr.docChanged)) next = closeEditing(next, tr.state);
    if (span || tr.selection || opened || next.editing !== value.editing) next = applyReveal(next, tr.state);
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.shown),
});

/** Reports the viewport to the field, only when it leaves the region already scanned. */
const viewportReporter = ViewPlugin.fromClass(
  class {
    private scheduled = false;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      this.check();
    }

    update(update: ViewUpdate): void {
      if (update.viewportChanged || update.docChanged) this.check();
    }

    private check(): void {
      if (this.scheduled || this.destroyed) return;
      const { scanned } = this.view.state.field(blockField);
      const { from, to } = this.view.viewport;
      const length = this.view.state.doc.length;
      const inside = from >= scanned.from && (to <= scanned.to || scanned.to >= length);
      if (inside) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.destroyed) return;
        this.view.dispatch({ effects: setBlockViewport.of(this.view.viewport) });
      });
    }

    destroy(): void {
      this.destroyed = true;
    }
  },
);

export const blockPreview = [blockField, viewportReporter];
