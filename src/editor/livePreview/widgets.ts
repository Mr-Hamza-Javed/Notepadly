// DOM widgets for the live preview. Heavy renderers show a sized placeholder, then swap.
import { redo, undo } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { applyFormat } from "../commands";
import { openBlockSource } from "./block";
import { cachedMath, cachedMermaid, cachedMermaidError, renderMath, renderMermaid, type RenderedHtml } from "../lazy";
import { findQueryOf } from "../find";
import { cellText, joinRow, parseAlign, parseTable, type TableRowModel } from "../tableModel";
import { documentPathChanged, isImagePath, parseSize, previewContext, resolveHref, resolveImageSrc, resolveWikiTarget } from "./context";

function element(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Attribute-free inline tags only, so a cell can never inject markup with handlers. */
const CELL_HTML_TAG = /&lt;(\/?)(sub|sup|kbd|u|ins|mark|b|strong|i|em|s|del|strike|small)&gt;/gi;
/** A link target with one level of balanced parentheses, as in `Foo_(bar)` (BUGS.md PREV-10). */
const LINK_TARGET = String.raw`((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?`;
const CELL_IMAGE = new RegExp(String.raw`!\[([^\]]*)\]\(` + LINK_TARGET + String.raw`\)`, "g");
const CELL_LINK = new RegExp(String.raw`\[([^\]]+)\]\(` + LINK_TARGET + String.raw`\)`, "g");
const CELL_EMBED = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const CELL_WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
/** Inline maths as the parser reads it: `$$x$$`, or `$x$` with no space inside and no word after. */
const CELL_MATH = /(?<![\\$])(\$\$(?![\s$])((?:\\.|[^\\$]|\$(?!\$))+?)\$\$|\$(?![\s$])((?:\\.|[^\\$])*?(?:\\.|[^\s\\$]))\$(?![\p{L}\p{N}_]))/gu;

/** Bold, italic, strike, highlight and the allowed HTML tags, on already escaped text. */
function cellEmphasis(html: string): string {
  return (
    html
      .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
      .replace(CELL_HTML_TAG, (_m, slash: string, tag: string) => `<${slash}${tag.toLowerCase()}>`)
      // Emphasis needs flanking markers: no space just inside them, so `2 * 3 * 4` stays text.
      .replace(/\*\*(?!\s)([^*]*[^*\s])\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*(?!\s)([^*]*[^*\s])\*/g, "$1<em>$2</em>")
      .replace(/(^|[^\w_])_(?!\s)([^_]*[^_\s])_(?![\w_])/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      .replace(/==([^=]+)==/g, "<mark>$1</mark>")
  );
}

function cellImage(src: string, alt: string, width?: number, height?: number): string {
  const resolved = resolveImageSrc(src.trim());
  const size = `${width ? ` width="${width}"` : ""}${height ? ` height="${height}"` : ""}`;
  const source = resolved ? ` src="${escapeHtml(resolved)}"` : "";
  return `<img class="cm-md-image cm-md-cell-image" alt="${escapeHtml(alt)}"${source}${size}>`;
}

/**
 * Small renderer for table cells. Cells are static HTML, so this stays deliberately simple.
 * Code spans, maths, images and links are taken out first, so emphasis rules never run
 * inside them (BUGS.md TAB-3); maths is filled in by `fillCellMath`.
 */
export function renderCellHtml(source: string): string {
  const parts: string[] = [];
  // NUL marks the placeholders; CommonMark shows it as U+FFFD anyway.
  const hold = (html: string) => `\u0000${parts.push(html) - 1}\u0000`;
  // GFM unescapes `\|` in a table cell before inline parsing, so inside code spans too.
  let text = source.replace(/\u0000/g, "\uFFFD").replace(/\\\|/g, "|");
  text = text
    .replace(/`([^`]+)`/g, (_m, code: string) => hold(`<code>${escapeHtml(code)}</code>`))
    .replace(CELL_MATH, (_m, _all, block: string | undefined, inline: string | undefined) => {
      const tex = (block ?? inline ?? "").trim();
      return hold(`<span class="cm-md-math-inline" data-math="${escapeHtml(tex)}">${escapeHtml(tex)}</span>`);
    })
    .replace(CELL_EMBED, (_m, target: string, alias: string | undefined) => {
      if (!isImagePath(target)) return hold(`<span class="cm-md-embed">${escapeHtml(alias || target.trim())}</span>`);
      const size = parseSize(alias ?? "");
      return hold(cellImage(target, size ? target.trim() : alias || target.trim(), size?.width, size?.height));
    })
    .replace(CELL_IMAGE, (_m, altText: string, src: string) => {
      const bar = altText.lastIndexOf("|");
      const size = bar >= 0 ? parseSize(altText.slice(bar + 1)) : null;
      return hold(cellImage(src, size ? altText.slice(0, bar) : altText, size?.width, size?.height));
    })
    .replace(CELL_LINK, (_m, label: string, href: string) =>
      hold(`<a data-href="${escapeHtml(href)}">${cellEmphasis(escapeHtml(label))}</a>`),
    )
    .replace(CELL_WIKILINK, (_m, target: string, alias: string | undefined) =>
      hold(
        `<a class="cm-md-wikilink" data-href="${escapeHtml(resolveWikiTarget(target))}">${escapeHtml(alias ?? target)}</a>`,
      ),
    );
  const restore = (html: string): string =>
    html.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => restore(parts[Number(index)]));
  return restore(cellEmphasis(escapeHtml(text)));
}

/** Renders the maths placeholders of a cell, from the cache or once KaTeX has loaded. */
function fillCellMath(cell: HTMLElement): void {
  for (const host of cell.querySelectorAll<HTMLElement>("[data-math]")) {
    const tex = host.dataset.math ?? "";
    const cached = cachedMath(tex, false);
    if (cached) {
      host.innerHTML = cached.html;
      continue;
    }
    renderMath(tex, false)
      .then((entry) => {
        if (host.isConnected && host.dataset.math === tex) host.innerHTML = entry.html;
      })
      .catch(() => host.classList.add("cm-md-render-error"));
  }
}

/** Shows a cell's markdown rendered. */
function setCellHtml(cell: HTMLElement, text: string): void {
  cell.dataset.src = text;
  cell.innerHTML = renderCellHtml(text);
  fillCellMath(cell);
}

/** Moves the cursor into the source when a rendered block is clicked. */
function placeCursor(view: EditorView, dom: HTMLElement, offset: number): void {
  const pos = view.posAtDOM(dom) + offset;
  view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) } });
  view.focus();
}

/**
 * Shows the markdown source of a rendered block (math, Mermaid, rule). Clicking such a block
 * never reveals it; this runs on double-click or from the block's edit button.
 */
function openSource(view: EditorView, dom: HTMLElement, offset: number): void {
  const start = view.posAtDOM(dom);
  view.dispatch({
    effects: openBlockSource.of(start),
    selection: { anchor: Math.min(start + offset, view.state.doc.length) },
  });
  view.focus();
}

/** Single click selects nothing, double-click opens the source, plus an optional edit button. */
function bindBlockSource(view: EditorView, host: HTMLElement, offset: number, withButton: boolean): void {
  host.addEventListener("mousedown", (event) => {
    event.preventDefault();
    if (event.detail >= 2) openSource(view, host, offset);
  });
  if (!withButton) return;
  const button = element("button", "cm-md-edit-source", "");
  button.title = "Edit source (or double-click)";
  button.tabIndex = -1;
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSource(view, host, offset);
  });
  host.appendChild(button);
}

/**
 * Where a block widget sits when it is inside a list, quote or callout (BUGS.md MD-1): the
 * quote and callout classes its lines would have had, and the list indentation in characters.
 */
export interface Nest {
  classes: string;
  indent: number;
}

export const TOP_LEVEL: Nest = { classes: "", indent: 0 };

function sameNest(a: Nest, b: Nest): boolean {
  return a.classes === b.classes && a.indent === b.indent;
}

function applyNest(dom: HTMLElement, nest: Nest): void {
  for (const name of Array.from(dom.classList)) {
    if (name.startsWith("cm-md-q") || name.startsWith("cm-md-callout") || name === "cm-md-nested") dom.classList.remove(name);
  }
  if (nest.classes) dom.classList.add("cm-md-nested", ...nest.classes.split(" "));
  dom.style.marginInlineStart = nest.indent ? `${nest.indent}ch` : "";
}

abstract class SourceWidget extends WidgetType {
  /** Rendered widgets take their own clicks and turn them into a cursor placement. */
  override ignoreEvent(): boolean {
    return true;
  }
}

export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  override eq(other: BulletWidget): boolean {
    return other.depth === this.depth;
  }
  toDOM(): HTMLElement {
    const glyph = ["•", "◦", "▪"][this.depth % 3];
    return element("span", "cm-md-bullet", glyph);
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-checkbox";
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute("aria-label", this.checked ? "Completed task" : "Task");
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const start = view.posAtDOM(box);
      const line = view.state.doc.lineAt(start);
      const marker = /\[[ xX]\]/.exec(line.text.slice(start - line.from));
      if (!marker) return;
      const from = start + marker.index + 1;
      view.dispatch({
        changes: { from, to: from + 1, insert: this.checked ? " " : "x" },
        userEvent: "input.toggle",
      });
    });
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

export class HorizontalRuleWidget extends SourceWidget {
  constructor(readonly nest: Nest = TOP_LEVEL) {
    super();
  }
  override eq(other: HorizontalRuleWidget): boolean {
    return sameNest(other.nest, this.nest);
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = element("div", "cm-md-hr");
    wrap.appendChild(document.createElement("hr"));
    bindBlockSource(view, wrap, 0, false);
    applyNest(wrap, this.nest);
    return wrap;
  }
}

/** Escapes pipes the user typed so they stay inside the cell. */
export function escapeCellText(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\\?\|/g, (match) => (match === "|" ? "\\|" : match));
}

interface CellRef {
  /** Source row index: 0 is the header, 1 the delimiter, body rows start at 2. */
  row: number;
  col: number;
}

/** Where focus lands in a cell: a source range inside the cell's text, or one of its ends. */
type CellTarget = "start" | "end" | { anchor: number; head: number };

/** Every table widget on screen, so engine commands and selection changes can reach them. */
const liveTables = new Set<TableController>();

/**
 * A rendered table whose cells are edited in place, like Obsidian. The table never turns
 * back into markdown source: each keystroke in a cell rewrites only that cell's text in the
 * document, and `updateDOM` refreshes the other cells without touching the one being edited.
 *
 * While a cell is edited, the editor's selection mirrors the caret in the cell, so commands
 * that work on the editor selection (Bold, Paste, F5, Copy, the table commands) act on the
 * cell (BUGS.md H1, M2).
 */
class TableController {
  readonly wrap = element("div", "cm-md-table");
  private source = "";
  private shape = "";
  private active: CellRef | null = null;
  private pendingFocus: (CellRef & { atEnd: boolean }) | null = null;
  private rebuilding = false;
  /** Parsed rows of `source`, parsed once per text (it was parsed ~5 times per keystroke). */
  private parsed: TableRowModel[] = [];
  /** Cells by source row and column; the delimiter row (1) has none. */
  private grid: HTMLElement[][] = [];
  /**
   * Cells that show Find matches or an editor selection as marked source while not focused,
   * by "row:col", with the marks drawn (BUGS.md H11, TAB-1).
   */
  private marked = new Map<string, string>();
  private readonly onSelectionChange = () => {
    if (this.active && this.wrap.isConnected) this.syncSelection();
  };

  constructor(readonly view: EditorView) {
    this.wrap.addEventListener("mousedown", (event) => this.onMouseDown(event));
    this.wrap.addEventListener("focusin", (event) => this.onFocusIn(event));
    this.wrap.addEventListener("focusout", (event) => this.onFocusOut(event));
    this.wrap.addEventListener("input", (event) => this.onInput(event));
    this.wrap.addEventListener("keydown", (event) => this.onKeyDown(event));
    liveTables.add(this);
  }

  destroy(): void {
    liveTables.delete(this);
    document.removeEventListener("selectionchange", this.onSelectionChange);
  }

  render(source: string): void {
    if (source === this.source && this.grid.length) return;
    const previous = this.parsed;
    const rows = parseTable(source);
    const columns = rows[0].cells.length;
    const shape = `${rows.length}x${columns}:${rows[1]?.text ?? ""}`;
    this.source = source;
    this.parsed = rows;
    if (findQueryOf(this.view.state) || this.marked.size) {
      // Matches move with the text; a new table needs its marks too (BUGS.md TAB-1).
      queueMicrotask(() => {
        if (this.wrap.isConnected) this.showMarks();
      });
    }
    if (shape !== this.shape) {
      this.shape = shape;
      this.rebuild(rows, columns);
      return;
    }
    for (let r = 0; r < rows.length; r++) {
      // Only rows whose text changed, and the cell being edited, need a look.
      if (previous[r]?.text === rows[r].text && this.active?.row !== r) continue;
      for (const cell of this.grid[r] ?? []) this.renderCell(cell, rows);
    }
  }

  private renderCell(cell: HTMLElement, rows: TableRowModel[]): void {
    const ref = this.refOf(cell);
    const text = cellText(rows[ref.row], ref.col);
    if (this.isActive(ref)) {
      // Markdown trims cells, so compare trimmed text or a trailing space would be undone.
      if (escapeCellText(cell.textContent ?? "").trim() !== text) {
        cell.textContent = text;
        caretTo(cell, true);
        // A command changed the text (Bold, Paste, Undo): put the caret where the editor's
        // selection is. Positions are only valid once CodeMirror finished this update.
        queueMicrotask(() => {
          if (this.isActive(ref) && this.wrap.isConnected) this.caretFromEditor(cell, ref);
        });
      }
    } else if (cell.dataset.src !== text) {
      this.marked.delete(`${ref.row}:${ref.col}`);
      setCellHtml(cell, text);
    }
  }

  private rebuild(rows: ReturnType<typeof parseTable>, columns: number): void {
    const restore = this.pendingFocus ?? (this.active ? { ...this.active, atEnd: true } : null);
    this.pendingFocus = null;
    this.rebuilding = true;
    const aligns = Array.from({ length: columns }, (_v, i) => parseAlign(cellText(rows[1], i)));
    const table = document.createElement("table");
    this.grid = [];
    const addRow = (parent: HTMLElement, rowIndex: number, cellTag: "th" | "td") => {
      const tr = document.createElement("tr");
      const line: HTMLElement[] = (this.grid[rowIndex] = []);
      for (let c = 0; c < columns; c++) {
        const cell = document.createElement(cellTag);
        const text = cellText(rows[rowIndex], c);
        cell.contentEditable = "plaintext-only";
        cell.spellcheck = this.view.contentDOM.spellcheck;
        cell.dataset.row = String(rowIndex);
        cell.dataset.col = String(c);
        // Urdu or Arabic text runs and aligns right to left; an explicit alignment still wins.
        cell.dir = "auto";
        setCellHtml(cell, text);
        if (aligns[c]) cell.style.textAlign = aligns[c]!;
        tr.appendChild(cell);
        line.push(cell);
      }
      parent.appendChild(tr);
    };
    const head = document.createElement("thead");
    addRow(head, 0, "th");
    table.appendChild(head);
    const body = document.createElement("tbody");
    for (let r = 2; r < rows.length; r++) addRow(body, r, "td");
    table.appendChild(body);
    this.wrap.replaceChildren(table);
    this.active = null;
    this.marked.clear();
    this.rebuilding = false;
    if (restore) {
      // rebuild runs inside CodeMirror's update (updateDOM); focusing dispatches, so wait.
      queueMicrotask(() => {
        // A removed last row falls back to the row above; the delimiter row has no cells.
        const row = Math.min(restore.row, rows.length - 1);
        const cell = this.cellAt(row === 1 ? 0 : row, Math.min(restore.col, columns - 1));
        if (cell && cell.isConnected) this.focusCell(cell, restore.atEnd ? "end" : "start");
      });
    }
  }

  private cells(): HTMLElement[] {
    return this.grid.flat();
  }

  private refOf(cell: HTMLElement): CellRef {
    return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
  }

  private isActive(ref: CellRef): boolean {
    return this.active !== null && this.active.row === ref.row && this.active.col === ref.col;
  }

  private cellAt(row: number, col: number): HTMLElement | null {
    return this.grid[row]?.[col] ?? null;
  }

  private bodyRows(): number[] {
    const rows = this.parsed.length;
    return [0, ...Array.from({ length: Math.max(0, rows - 2) }, (_v, i) => i + 2)];
  }

  private columns(): number {
    return this.parsed[0].cells.length;
  }

  /** Focuses a cell and places the caret; a range is in source offsets within the cell's text. */
  focusCell(cell: HTMLElement, target: CellTarget): void {
    cell.focus({ preventScroll: false });
    if (typeof target === "string") {
      caretTo(cell, target === "end");
    } else {
      const text = cell.textContent ?? "";
      const length = this.cellRange(this.refOf(cell)).length;
      selectText(cell, sourceToDom(text, target.anchor, length), sourceToDom(text, target.head, length));
    }
    this.syncSelection();
  }

  /** Start of the table in the current document. */
  tableStart(): number {
    return this.view.posAtDOM(this.wrap);
  }

  /** Document range of the table. */
  range(): { from: number; to: number } {
    const from = this.tableStart();
    return { from, to: from + this.source.length };
  }

  /** Document position of a cell's text and its length. A missing cell sits at the end of its row. */
  private cellRange(ref: CellRef): { from: number; length: number } {
    const row = this.parsed[ref.row];
    const base = this.tableStart() + row.offset;
    const span = row.cells[ref.col];
    return span ? { from: base + span.from, length: span.to - span.from } : { from: base + row.text.length, length: 0 };
  }

  /** The cell at a document position, or the nearest one on its row (the header for the delimiter row). */
  private cellFor(from: number): HTMLElement | null {
    const start = this.tableStart();
    const rows = this.parsed;
    for (let r = rows.length - 1; r >= 0; r--) {
      if (start + rows[r].offset > from) continue;
      const row = rows[r === 1 ? 0 : r];
      const base = start + row.offset;
      let col = 0;
      for (let c = 0; c < row.cells.length; c++) {
        if (base + row.cells[c].from <= from) col = c;
      }
      return this.cellAt(r === 1 ? 0 : r, Math.min(col, this.columns() - 1));
    }
    return null;
  }

  /** Mirrors the caret or selection in the active cell into the editor's selection. */
  private syncSelection(): void {
    const ref = this.active;
    const cell = ref ? this.cellAt(ref.row, ref.col) : null;
    if (!ref || !cell || !this.wrap.isConnected) return;
    const selected = cellSelection(cell);
    if (!selected) return;
    const { from, length } = this.cellRange(ref);
    const text = cell.textContent ?? "";
    const anchor = from + domToSource(text, selected.anchor, length);
    const head = from + domToSource(text, selected.head, length);
    const main = this.view.state.selection.main;
    if (main.anchor === anchor && main.head === head && this.view.state.selection.ranges.length === 1) return;
    this.view.dispatch({ selection: { anchor, head } });
  }

  /** Puts the cell's caret where the editor's selection is, or at its end if that is elsewhere. */
  private caretFromEditor(cell: HTMLElement, ref: CellRef): void {
    const { from, length } = this.cellRange(ref);
    const main = this.view.state.selection.main;
    const text = cell.textContent ?? "";
    if (main.from < from || main.to > from + length) {
      caretTo(cell, true);
    } else {
      selectText(cell, sourceToDom(text, main.anchor - from, length), sourceToDom(text, main.head - from, length));
    }
    this.syncSelection();
  }

  /** Is focus in one of this table's cells? */
  hasFocus(): boolean {
    return this.active !== null && this.wrap.contains(document.activeElement);
  }

  /** Selects the whole text of the focused cell (Ctrl+A, BUGS.md M1). */
  selectActiveCell(): boolean {
    const cell = this.active ? this.cellAt(this.active.row, this.active.col) : null;
    if (!cell || !this.hasFocus()) return false;
    selectText(cell, 0, (cell.textContent ?? "").length);
    this.syncSelection();
    return true;
  }

  /**
   * Edits the focused cell at its caret the way typing does (the `input` event then writes the
   * cell), for Paste, F5 and Cut from the menus. Going through the editor selection lost a space
   * typed at the end of the cell, since the cell's markdown is trimmed: "Due " then F5 gave
   * "Due4:49 PM" (found by e2e). False when there is no focused cell or the browser cannot.
   */
  editInCell(text: string | null): boolean {
    const cell = this.active ? this.cellAt(this.active.row, this.active.col) : null;
    const selected = cell && this.hasFocus() ? cellSelection(cell) : null;
    if (!selected || (text === null && selected.anchor === selected.head)) return false;
    try {
      return text === null ? document.execCommand("delete") : document.execCommand("insertText", false, text);
    } catch {
      return false;
    }
  }

  /** Moves focus into the cell at a document position (the editor's cursor went into the table). */
  focusAt(anchor: number, head: number): void {
    const cell = this.cellFor(Math.min(anchor, head));
    if (!cell) return;
    const { from, length } = this.cellRange(this.refOf(cell));
    const clamp = (pos: number) => Math.min(length, Math.max(0, pos - from));
    this.focusCell(cell, { anchor: clamp(anchor), head: clamp(head) });
  }

  /** Enters the table from the keyboard: from above into the first cell, from below into the last row. */
  enter(fromAbove: boolean, toLastCell: boolean): void {
    const order = this.bodyRows();
    const row = fromAbove ? 0 : order[order.length - 1];
    const col = !fromAbove && toLastCell ? this.columns() - 1 : 0;
    const cell = this.cellAt(row, col);
    if (cell) this.focusCell(cell, fromAbove ? "start" : toLastCell ? "end" : "start");
  }

  /** Renders every cell again, e.g. after the document moved and relative images changed. */
  refreshCells(): void {
    for (const cell of this.cells()) {
      const ref = this.refOf(cell);
      if (!this.isActive(ref) && !this.marked.has(`${ref.row}:${ref.col}`)) setCellHtml(cell, cell.dataset.src ?? "");
    }
  }

  /**
   * Shows every Find match in this table's cells, and an editor selection inside one cell while
   * no cell is focused (BUGS.md H11, TAB-1). A cell with marks shows its markdown, so a mark
   * sits exactly on the matched text; the current match or selection is the strong mark.
   */
  showMarks(): void {
    const state = this.view.state;
    const main = state.selection.main;
    const { from: start, to: end } = this.range();
    const rows = this.parsed;
    const wanted = new Map<string, { ref: CellRef; marks: { from: number; to: number; current: boolean }[] }>();
    let row = 0;
    const add = (from: number, to: number, current: boolean) => {
      if (from < start || to > end) return;
      const rel = from - start;
      while (row + 1 < rows.length && rows[row + 1].offset <= rel) row++;
      if (row === 1) return;
      const line = rows[row];
      const col = line.cells.findIndex(
        (span) => line.offset + span.from <= rel && to - start <= line.offset + span.to,
      );
      if (col < 0 || col >= (this.grid[row]?.length ?? 0) || this.isActive({ row, col })) return;
      const key = `${row}:${col}`;
      const base = start + line.offset + line.cells[col].from;
      let entry = wanted.get(key);
      if (!entry) wanted.set(key, (entry = { ref: { row, col }, marks: [] }));
      const mark = { from: from - base, to: to - base, current };
      if (!entry.marks.some((m) => m.from === mark.from && m.to === mark.to)) entry.marks.push(mark);
      else if (current) entry.marks = entry.marks.map((m) => (m.from === mark.from ? mark : m));
    };
    const query = findQueryOf(state);
    if (query?.valid) {
      const cursor = query.getCursor(state, start, end);
      let count = 0;
      for (let step = cursor.next(); !step.done && count < 5000; step = cursor.next(), count++) {
        const { from, to } = step.value;
        if (to > from) add(from, to, from === main.from && to === main.to);
      }
    }
    if (!this.hasFocus() && !main.empty) {
      row = 0;
      add(main.from, main.to, true);
    }
    let scrollTo: HTMLElement | null = null;
    for (const key of this.marked.keys()) {
      if (wanted.has(key)) continue;
      this.marked.delete(key);
      const [r, c] = key.split(":").map(Number);
      const cell = this.cellAt(r, c);
      if (cell && !this.isActive({ row: r, col: c })) setCellHtml(cell, cell.dataset.src ?? "");
    }
    for (const [key, { ref, marks }] of wanted) {
      marks.sort((x, y) => x.from - y.from);
      const signature = JSON.stringify(marks);
      if (this.marked.get(key) === signature) continue;
      const hadCurrent = this.marked.get(key)?.includes('"current":true') ?? false;
      this.marked.set(key, signature);
      const cell = this.cellAt(ref.row, ref.col)!;
      const text = cellText(rows[ref.row], ref.col);
      const parts: (string | Node)[] = [];
      let at = 0;
      for (const mark of marks) {
        if (mark.from < at) continue;
        parts.push(text.slice(at, mark.from));
        const node = element("mark", mark.current ? "cm-md-cell-selection" : "cm-find-match", text.slice(mark.from, mark.to));
        if (mark.current && !hadCurrent) scrollTo = node;
        parts.push(node);
        at = mark.to;
      }
      parts.push(text.slice(at));
      cell.replaceChildren(...parts);
    }
    scrollTo?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  private onMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const anchor = target.closest<HTMLElement>("a[data-href]");
    if (anchor && event.ctrlKey) {
      event.preventDefault();
      previewContext.openLink(resolveHref(anchor.dataset.href ?? ""));
      return;
    }
    if (!target.closest("th,td")) event.preventDefault();
  }

  private onFocusIn(event: FocusEvent): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("th,td");
    if (!cell) return;
    const ref = this.refOf(cell);
    if (this.isActive(ref)) return;
    this.active = ref;
    this.marked.delete(`${ref.row}:${ref.col}`);
    cell.classList.add("is-editing");
    document.addEventListener("selectionchange", this.onSelectionChange);
    // Show this cell's markdown while it is edited, like Obsidian.
    const text = cellText(this.parsed[ref.row], ref.col);
    if (cell.textContent !== text || cell.childElementCount > 0) {
      cell.textContent = text;
      caretTo(cell, true);
    }
    // Park the editor selection in the cell, so toolbar and menu commands apply to it.
    queueMicrotask(() => {
      if (this.wrap.isConnected && this.isActive(ref)) this.syncSelection();
    });
  }

  private onFocusOut(event: FocusEvent): void {
    if (this.rebuilding) return;
    const cell = (event.target as HTMLElement).closest<HTMLElement>("th,td");
    if (!cell) return;
    cell.classList.remove("is-editing");
    const ref = this.refOf(cell);
    if (this.isActive(ref)) {
      this.active = null;
      document.removeEventListener("selectionchange", this.onSelectionChange);
    }
    const text = cellText(this.parsed[ref.row], ref.col);
    setCellHtml(cell, text);
  }

  private onInput(event: Event): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("th,td");
    if (!cell) return;
    this.writeCell(this.refOf(cell), escapeCellText(cell.textContent ?? "").trim());
    if (this.isActive(this.refOf(cell))) this.syncSelection();
  }

  private writeCell(ref: CellRef, text: string): void {
    const rows = this.parsed;
    const row = rows[ref.row];
    const start = this.tableStart();
    const span = row.cells[ref.col];
    if (span && row.text.slice(span.from, span.to) === text) return;
    // In a row without a leading pipe the first cell is also the start of the line, so `- `,
    // `# ` or `> ` typed there would start a list, heading or quote and cut the table. Writing
    // the row with its pipes keeps the text in the cell (BUGS.md PREV-6).
    const leadingPipe = row.text.slice(row.prefix.length).startsWith("|");
    if (ref.col === 0 && !leadingPipe) {
      const values = Array.from({ length: Math.max(this.columns(), row.cells.length) }, (_v, c) =>
        c === 0 ? text : cellText(row, c),
      );
      this.view.dispatch({
        changes: { from: start + row.offset, to: start + row.offset + row.text.length, insert: formatRow(values, row.prefix) },
        userEvent: "input.type",
      });
      return;
    }
    if (span && span.from === span.to) {
      // Empty cell: its span is a point after the padding, so fill the whole gap between pipes.
      let from = span.from;
      let to = span.to;
      while (from > 0 && row.text[from - 1] === " ") from--;
      while (to < row.text.length && row.text[to] === " ") to++;
      this.view.dispatch({
        changes: { from: start + row.offset + from, to: start + row.offset + to, insert: ` ${text} ` },
        userEvent: "input.type",
      });
      return;
    }
    if (span) {
      // A backslash right before the closing pipe would escape it and merge two cells (BUGS.md L9).
      const pad = text.endsWith("\\") && row.text[span.to] === "|" ? " " : "";
      this.view.dispatch({
        changes: { from: start + row.offset + span.from, to: start + row.offset + span.to, insert: text + pad },
        userEvent: "input.type",
      });
      return;
    }
    // The row has fewer cells than the header: rewrite the whole row.
    const values = Array.from({ length: this.columns() }, (_v, c) => (c === ref.col ? text : cellText(row, c)));
    this.view.dispatch({
      changes: {
        from: start + row.offset,
        to: start + row.offset + row.text.length,
        insert: formatRow(values, row.prefix),
      },
      userEvent: "input.type",
    });
  }

  private addRow(focusCol: number): void {
    const rows = this.parsed;
    const last = rows[rows.length - 1];
    const end = this.tableStart() + last.offset + last.text.length;
    this.pendingFocus = { row: rows.length, col: focusCol, atEnd: true };
    this.view.dispatch({
      changes: { from: end, insert: "\n" + formatRow(Array.from({ length: this.columns() }, () => ""), last.prefix) },
      userEvent: "input",
    });
  }

  /**
   * Puts the editor cursor on the line just before or after the table and focuses the editor.
   * With no line there, arrow keys stay in the cell, like on the first or last line of a
   * document (BUGS.md H3, M5). Escape at the end of the document adds a blank line and a line to land on, kept
   * out of the undo history so the tab does not turn unsaved. While the rest of the file is
   * still loading, that line would end up in the middle of the file, so Escape stays in the
   * cell (BUGS.md TAB-4).
   */
  private leave(after: boolean, escape = false): void {
    const { from: start, to: end } = this.range();
    const doc = this.view.state.doc;
    if (after && end >= doc.length) {
      if (!escape || !previewContext.isFullyLoaded()) return;
      // A blank line first: text typed on a line right under a table is a table row in GFM,
      // so the line to land on alone would put what is typed next back in the table.
      this.view.dispatch({
        changes: { from: doc.length, insert: "\n\n" },
        selection: { anchor: doc.length + 2 },
        annotations: Transaction.addToHistory.of(false),
        scrollIntoView: true,
      });
      this.view.focus();
      return;
    }
    if (!after && start === 0) return;
    this.view.dispatch({ selection: { anchor: after ? end + 1 : start - 1 }, scrollIntoView: true });
    this.view.focus();
  }

  private move(ref: CellRef, dRow: number, dCol: number, atEnd: boolean): void {
    const order = this.bodyRows();
    const columns = this.columns();
    let index = order.indexOf(ref.row);
    let col = ref.col + dCol;
    if (col >= columns) {
      col = 0;
      index++;
    } else if (col < 0) {
      col = columns - 1;
      index--;
    }
    index += dRow;
    if (index < 0) return this.leave(false);
    if (index >= order.length) return this.leave(true);
    const cell = this.cellAt(order[index], col);
    if (cell) this.focusCell(cell, atEnd ? "end" : "start");
  }

  private onKeyDown(event: KeyboardEvent): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("th,td");
    if (!cell) return;
    const ref = this.refOf(cell);
    const order = this.bodyRows();
    const isLastRow = order.indexOf(ref.row) === order.length - 1;
    const mod = event.ctrlKey || event.metaKey;
    const caret = caretInfo(cell);
    let handled = true;

    if (event.key === "Tab") {
      const lastCell = isLastRow && ref.col === this.columns() - 1;
      if (!event.shiftKey && lastCell) this.addRow(0);
      else this.move(ref, 0, event.shiftKey ? -1 : 1, true);
    } else if (event.key === "Enter" && event.shiftKey) {
      this.syncSelection();
      this.view.dispatch(this.view.state.replaceSelection("<br>"), { userEvent: "input" });
    } else if (event.key === "Enter") {
      if (isLastRow) this.addRow(ref.col);
      else this.move(ref, 1, 0, true);
    } else if (event.key === "Escape") {
      this.leave(true, true);
    } else if (event.key === "ArrowUp" && !event.shiftKey) {
      this.move(ref, -1, 0, true);
    } else if (event.key === "ArrowDown" && !event.shiftKey) {
      this.move(ref, 1, 0, true);
    } else if (event.key === "ArrowLeft" && !event.shiftKey && caret.atStart) {
      this.move(ref, 0, -1, true);
    } else if (event.key === "ArrowRight" && !event.shiftKey && caret.atEnd) {
      this.move(ref, 0, 1, false);
    } else if (mod && !event.altKey && (event.key === "z" || event.key === "Z") && !event.shiftKey) {
      undo(this.view);
    } else if (mod && !event.altKey && (event.key === "y" || ((event.key === "z" || event.key === "Z") && event.shiftKey))) {
      redo(this.view);
    } else if (mod && !event.altKey && !event.shiftKey && (event.key === "a" || event.key === "A")) {
      this.selectActiveCell();
    } else if (mod && !event.altKey && !event.shiftKey && (event.key === "b" || event.key === "i")) {
      // The same command as the toolbar, on the editor selection that mirrors the cell's.
      this.syncSelection();
      applyFormat(this.view, { type: event.key === "b" ? "bold" : "italic" });
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
}

function formatRow(values: string[], prefix = ""): string {
  return joinRow(prefix, values.map((value) => value || " "));
}

function caretTo(cell: HTMLElement, atEnd: boolean): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(!atEnd);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Text offset of a DOM point inside a cell. */
function textOffset(cell: HTMLElement, node: Node, offset: number): number {
  const before = document.createRange();
  before.selectNodeContents(cell);
  before.setEnd(node, offset);
  return before.toString().length;
}

/** The DOM point at a text offset inside a cell. */
function pointAt(cell: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let left = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (left <= node.length) return [node, left];
    left -= node.length;
    last = node;
  }
  return last ? [last, last.length] : [cell, 0];
}

function selectText(cell: HTMLElement, anchor: number, head: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const [anchorNode, anchorOffset] = pointAt(cell, anchor);
  const [headNode, headOffset] = pointAt(cell, head);
  selection.removeAllRanges();
  selection.setBaseAndExtent(anchorNode, anchorOffset, headNode, headOffset);
}

/** The selection inside a cell as text offsets, or null when it is not in the cell. */
function cellSelection(cell: HTMLElement): { anchor: number; head: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode || !cell.contains(anchorNode) || !cell.contains(focusNode)) return null;
  return { anchor: textOffset(cell, anchorNode, anchorOffset), head: textOffset(cell, focusNode, focusOffset) };
}

/**
 * Maps a caret offset in a cell being edited to an offset in the cell's markdown. They differ
 * where the document is ahead of the screen: typed pipes are escaped and the text is trimmed.
 */
function domToSource(text: string, offset: number, sourceLength: number): number {
  return Math.min(escapeCellText(text.slice(0, offset)).trimStart().length, sourceLength);
}

function sourceToDom(text: string, offset: number, sourceLength: number): number {
  for (let i = 0; i <= text.length; i++) if (domToSource(text, i, sourceLength) >= offset) return i;
  return text.length;
}

function caretInfo(cell: HTMLElement): { atStart: boolean; atEnd: boolean } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return { atStart: false, atEnd: false };
  const range = selection.getRangeAt(0);
  const offset = textOffset(cell, range.startContainer, range.startOffset);
  return { atStart: offset === 0, atEnd: offset === (cell.textContent ?? "").length };
}

const tableControllers = new WeakMap<HTMLElement, TableController>();

/** The rendered tables of a view. */
function tablesOf(view: EditorView): TableController[] {
  return Array.from(liveTables).filter((table) => table.view === view && table.wrap.isConnected);
}

/** The table whose cell has focus, if any. */
export function focusedTable(view: EditorView): TableController | null {
  return tablesOf(view).find((table) => table.hasFocus()) ?? null;
}

/** The rendered table that contains a document position, if any. */
export function tableAt(view: EditorView, pos: number): TableController | null {
  return (
    tablesOf(view).find((table) => {
      const { from, to } = table.range();
      return pos >= from && pos <= to;
    }) ?? null
  );
}

/**
 * Keeps keyboard focus and the editor selection in step with rendered tables:
 * - an arrow key that lands the cursor on a table's edge enters the table (BUGS.md H2);
 * - a cursor put inside a table while the editor has focus (after a dialog or undo) moves
 *   into the matching cell, so typing never edits hidden table source;
 * - a selection inside a table with no focused cell, like a Find match, is shown in its cell
 *   (BUGS.md H11).
 */
export const tableFocus = ViewPlugin.fromClass(
  class {
    private scheduled = false;
    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (update.transactions.some((tr) => tr.effects.some((e) => e.is(documentPathChanged)))) {
        // Relative images in cells resolve against the new folder (BUGS.md PREV-7).
        for (const table of tablesOf(this.view)) table.refreshCells();
      }
      const queryChanged = findQueryOf(update.state) !== findQueryOf(update.startState);
      if (!update.selectionSet && !update.docChanged && !update.focusChanged && !queryChanged) return;
      const keyboard = update.transactions.some((tr) => tr.isUserEvent("select") && !tr.isUserEvent("select.pointer"));
      const typed = update.docChanged && update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"));
      this.schedule(keyboard, typed, update.startState.selection.main.head);
    }

    private typed = false;

    private schedule(keyboard: boolean, typed: boolean, oldHead: number): void {
      this.typed ||= typed;
      if (this.scheduled) return;
      this.scheduled = true;
      // Positions of widgets are only known once this update has drawn them.
      queueMicrotask(() => {
        this.scheduled = false;
        const typedNow = this.typed;
        this.typed = false;
        this.reconcile(keyboard, typedNow, oldHead);
      });
    }

    private reconcile(keyboard: boolean, typed: boolean, oldHead: number): void {
      const view = this.view;
      if (!view.dom.isConnected) return;
      const main = view.state.selection.main;
      for (const table of tablesOf(view)) table.showMarks();
      if (!view.hasFocus || focusedTable(view)) return;
      const table = tableAt(view, main.head);
      if (!table) return;
      const { from, to } = table.range();
      if (main.empty && (main.head === from || main.head === to)) {
        if (keyboard) table.enter(oldHead < from, oldHead === to + 1);
        // Typing on the line right under a table can make that line a table row (GFM lazy
        // rows), leaving the cursor at the hidden end of the table: the next keys then went
        // to the start of the document. Carry on in the new row's cell (found by e2e).
        else if (typed && main.head === to) table.focusAt(main.head, main.head);
      } else if (main.from > from && main.to < to) {
        table.focusAt(main.anchor, main.head);
      }
    }
  },
);

export class TableWidget extends SourceWidget {
  constructor(
    readonly source: string,
    readonly nest: Nest = TOP_LEVEL,
  ) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source && sameNest(other.nest, this.nest);
  }
  override get estimatedHeight(): number {
    return 34 * Math.max(1, this.source.split("\n").length - 1) + 12;
  }
  toDOM(view: EditorView): HTMLElement {
    const controller = new TableController(view);
    controller.render(this.source);
    applyNest(controller.wrap, this.nest);
    tableControllers.set(controller.wrap, controller);
    return controller.wrap;
  }
  /** Keeps the same DOM (and the focused cell) when only the table's text changed. */
  override updateDOM(dom: HTMLElement): boolean {
    const controller = tableControllers.get(dom);
    if (!controller) return false;
    controller.render(this.source);
    applyNest(dom, this.nest);
    return true;
  }
  override destroy(dom: HTMLElement): void {
    tableControllers.get(dom)?.destroy();
  }
}

function applyRendered(view: EditorView, host: HTMLElement, entry: RenderedHtml): void {
  host.classList.remove("cm-md-pending");
  host.style.minHeight = "";
  const button = host.querySelector(".cm-md-edit-source");
  host.innerHTML = entry.html;
  if (button) host.appendChild(button);
  view.requestMeasure({
    read: () => host.offsetHeight,
    write: (height) => {
      if (height > 0) entry.height = height;
    },
  });
}

export class MathWidget extends SourceWidget {
  constructor(
    readonly source: string,
    readonly display: boolean,
    /** Offset of the math text from the start of the replaced range. */
    readonly sourceOffset: number,
    readonly nest: Nest = TOP_LEVEL,
  ) {
    super();
  }
  override eq(other: MathWidget): boolean {
    // The offset is baked into the click handlers, so a moved source needs a new DOM.
    return (
      other.source === this.source &&
      other.display === this.display &&
      other.sourceOffset === this.sourceOffset &&
      sameNest(other.nest, this.nest)
    );
  }
  override get estimatedHeight(): number {
    if (!this.display) return -1;
    return cachedMath(this.source, true)?.height || 56;
  }
  toDOM(view: EditorView): HTMLElement {
    const host = element(this.display ? "div" : "span", this.display ? "cm-md-math-block" : "cm-md-math-inline");
    const cached = cachedMath(this.source, this.display);
    if (cached) {
      applyRendered(view, host, cached);
    } else {
      host.classList.add("cm-md-pending");
      host.textContent = this.source;
      if (this.display) host.style.minHeight = "56px";
      renderMath(this.source, this.display)
        .then((entry) => applyRendered(view, host, entry))
        .catch(() => host.classList.add("cm-md-render-error"));
    }
    if (this.display) {
      bindBlockSource(view, host, this.sourceOffset, true);
      applyNest(host, this.nest);
    } else {
      // Inline math reveals like other inline syntax when clicked.
      host.addEventListener("mousedown", (event) => {
        event.preventDefault();
        placeCursor(view, host, this.sourceOffset);
      });
    }
    return host;
  }
}

export class MermaidWidget extends SourceWidget {
  constructor(
    readonly source: string,
    readonly dark: boolean,
    readonly sourceOffset: number,
    readonly nest: Nest = TOP_LEVEL,
  ) {
    super();
  }
  override eq(other: MermaidWidget): boolean {
    return (
      other.source === this.source &&
      other.dark === this.dark &&
      other.sourceOffset === this.sourceOffset &&
      sameNest(other.nest, this.nest)
    );
  }
  override get estimatedHeight(): number {
    return cachedMermaid(this.source, this.dark)?.height || 260;
  }
  toDOM(view: EditorView): HTMLElement {
    const host = element("div", "cm-md-mermaid");
    const cached = cachedMermaid(this.source, this.dark);
    const failed = cached ? undefined : cachedMermaidError(this.source, this.dark);
    if (cached) {
      applyRendered(view, host, cached);
    } else if (failed !== undefined) {
      host.classList.add("cm-md-render-error");
      host.textContent = failed;
    } else {
      host.classList.add("cm-md-pending");
      host.style.minHeight = "260px";
      host.textContent = "Rendering diagram…";
      renderMermaid(this.source, this.dark)
        .then((entry) => applyRendered(view, host, entry))
        .catch((error: unknown) => {
          host.classList.remove("cm-md-pending");
          host.classList.add("cm-md-render-error");
          host.style.minHeight = "";
          const button = host.querySelector(".cm-md-edit-source");
          host.textContent = error instanceof Error ? error.message : "Could not render this diagram.";
          if (button) host.appendChild(button);
          view.requestMeasure();
        });
    }
    bindBlockSource(view, host, this.sourceOffset, true);
    applyNest(host, this.nest);
    return host;
  }
}

/** Natural heights of loaded images, so a re-created widget does not jump. */
const imageHeights = new Map<string, number>();

export class ImageWidget extends WidgetType {
  /** The URL the image loads from; it changes when the document moves (BUGS.md PREV-7). */
  readonly resolved: string;
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width?: number,
    readonly height?: number,
  ) {
    super();
    this.resolved = resolveImageSrc(src);
  }
  override eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.resolved === this.resolved &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height
    );
  }
  override get estimatedHeight(): number {
    return this.height ?? imageHeights.get(this.src) ?? 200;
  }
  toDOM(view: EditorView): HTMLElement {
    const image = document.createElement("img");
    image.className = "cm-md-image";
    image.alt = this.alt;
    image.loading = "lazy";
    image.decoding = "async";
    if (this.width) image.width = this.width;
    if (this.height) image.height = this.height;
    image.addEventListener("load", () => {
      imageHeights.set(this.src, image.offsetHeight);
      view.requestMeasure();
    });
    image.addEventListener("error", () => {
      image.classList.add("cm-md-image-broken");
      view.requestMeasure();
    });
    if (this.resolved) image.src = this.resolved;
    else image.classList.add("cm-md-image-broken");
    // Clicking an image keeps it rendered; double-click shows its markdown to edit.
    image.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (event.detail < 2) return;
      const pos = view.posAtDOM(image);
      view.dispatch({ selection: { anchor: pos + 2 } });
      view.focus();
    });
    return image;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

export class EmbedPillWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: EmbedPillWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    return element("span", "cm-md-embed", this.label);
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const CALLOUT_ICONS: Record<string, string> = {
  note: "",
  info: "",
  tip: "",
  hint: "",
  important: "",
  success: "",
  check: "",
  done: "",
  question: "",
  help: "",
  faq: "",
  warning: "",
  caution: "",
  attention: "",
  danger: "",
  error: "",
  failure: "",
  fail: "",
  bug: "",
  example: "",
  quote: "",
  cite: "",
  abstract: "",
  summary: "",
  todo: "",
};

export class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly defaultTitle: string,
    readonly foldable: boolean,
    readonly folded: boolean,
    readonly onToggle: (view: EditorView, pos: number) => void,
  ) {
    super();
  }
  override eq(other: CalloutTitleWidget): boolean {
    return (
      other.kind === this.kind &&
      other.defaultTitle === this.defaultTitle &&
      other.foldable === this.foldable &&
      other.folded === this.folded
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = element("span", "cm-md-callout-head");
    wrap.appendChild(element("span", "cm-md-callout-icon", CALLOUT_ICONS[this.kind] ?? CALLOUT_ICONS.note));
    if (this.defaultTitle) wrap.appendChild(element("span", "cm-md-callout-default", this.defaultTitle));
    if (this.foldable) {
      const chevron = element(
        "span",
        `cm-md-callout-fold${this.folded ? " is-folded" : ""}`,
        "",
      );
      chevron.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onToggle(view, view.posAtDOM(wrap));
      });
      wrap.appendChild(chevron);
    }
    return wrap;
  }
  override ignoreEvent(event: Event): boolean {
    return (event.target as HTMLElement).classList.contains("cm-md-callout-fold");
  }
}

export class CodeLabelWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: CodeLabelWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    return element("span", "cm-md-code-label", this.label);
  }
  override ignoreEvent(): boolean {
    return false;
  }
}
