// DOM widgets for the live preview. Heavy renderers show a sized placeholder, then swap.
import { redo, undo } from "@codemirror/commands";
import { EditorView, WidgetType } from "@codemirror/view";
import { openBlockSource } from "./block";
import { cachedMath, cachedMermaid, renderMath, renderMermaid, type RenderedHtml } from "../lazy";
import { cellText, parseAlign, parseTable } from "../tableModel";
import { previewContext, resolveHref, resolveImageSrc } from "./context";

function element(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Small renderer for table cells. Cells are static HTML, so this stays deliberately simple. */
export function renderCellHtml(source: string): string {
  const codeSpans: string[] = [];
  let html = escapeHtml(source).replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  html = html
    .replace(/\\\|/g, "|")
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    // Attribute-free inline tags only, so a cell can never inject markup with handlers.
    .replace(
      /&lt;(\/?)(sub|sup|kbd|u|ins|mark|b|strong|i|em|s|del|strike|small)&gt;/gi,
      (_m, slash: string, tag: string) => `<${slash}${tag.toLowerCase()}>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/==([^=]+)==/g, "<mark>$1</mark>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a data-href="$2">$1</a>');
  return html.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codeSpans[Number(index)]);
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
  override eq(): boolean {
    return true;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = element("div", "cm-md-hr");
    wrap.appendChild(document.createElement("hr"));
    bindBlockSource(view, wrap, 0, false);
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

/**
 * A rendered table whose cells are edited in place, like Obsidian. The table never turns
 * back into markdown source: each keystroke in a cell rewrites only that cell's text in the
 * document, and `updateDOM` refreshes the other cells without touching the one being edited.
 */
class TableController {
  readonly wrap = element("div", "cm-md-table");
  private source = "";
  private shape = "";
  private active: CellRef | null = null;
  private pendingFocus: (CellRef & { atEnd: boolean }) | null = null;
  private rebuilding = false;

  constructor(private readonly view: EditorView) {
    this.wrap.addEventListener("mousedown", (event) => this.onMouseDown(event));
    this.wrap.addEventListener("focusin", (event) => this.onFocusIn(event));
    this.wrap.addEventListener("focusout", (event) => this.onFocusOut(event));
    this.wrap.addEventListener("input", (event) => this.onInput(event));
    this.wrap.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  render(source: string): void {
    const rows = parseTable(source);
    const columns = rows[0].cells.length;
    const shape = `${rows.length}x${columns}:${rows[1]?.text ?? ""}`;
    this.source = source;
    if (shape !== this.shape) {
      this.shape = shape;
      this.rebuild(rows, columns);
      return;
    }
    for (const cell of this.cells()) {
      const ref = this.refOf(cell);
      const text = cellText(rows[ref.row], ref.col);
      if (this.isActive(ref)) {
        // Markdown trims cells, so compare trimmed text or a trailing space would be undone.
        if (escapeCellText(cell.textContent ?? "").trim() !== text) {
          cell.textContent = text;
          caretTo(cell, true);
        }
      } else if (cell.dataset.src !== text) {
        cell.dataset.src = text;
        cell.innerHTML = renderCellHtml(text);
      }
    }
  }

  private rebuild(rows: ReturnType<typeof parseTable>, columns: number): void {
    const restore = this.pendingFocus ?? (this.active ? { ...this.active, atEnd: true } : null);
    this.pendingFocus = null;
    this.rebuilding = true;
    const aligns = Array.from({ length: columns }, (_v, i) => parseAlign(cellText(rows[1], i)));
    const table = document.createElement("table");
    const addRow = (parent: HTMLElement, rowIndex: number, cellTag: "th" | "td") => {
      const tr = document.createElement("tr");
      for (let c = 0; c < columns; c++) {
        const cell = document.createElement(cellTag);
        const text = cellText(rows[rowIndex], c);
        cell.contentEditable = "plaintext-only";
        cell.spellcheck = this.view.contentDOM.spellcheck;
        cell.dataset.row = String(rowIndex);
        cell.dataset.col = String(c);
        cell.dataset.src = text;
        cell.innerHTML = renderCellHtml(text);
        if (aligns[c]) cell.style.textAlign = aligns[c]!;
        tr.appendChild(cell);
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
    this.rebuilding = false;
    if (restore) {
      // rebuild runs inside CodeMirror's update (updateDOM); focusing dispatches, so wait.
      queueMicrotask(() => {
        const cell = this.cellAt(Math.min(restore.row, rows.length - 1), Math.min(restore.col, columns - 1));
        if (cell && cell.isConnected) this.focusCell(cell, restore.atEnd);
      });
    }
  }

  private cells(): HTMLElement[] {
    return Array.from(this.wrap.querySelectorAll<HTMLElement>("th,td"));
  }

  private refOf(cell: HTMLElement): CellRef {
    return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
  }

  private isActive(ref: CellRef): boolean {
    return this.active !== null && this.active.row === ref.row && this.active.col === ref.col;
  }

  private cellAt(row: number, col: number): HTMLElement | null {
    return this.wrap.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
  }

  private bodyRows(): number[] {
    const rows = parseTable(this.source).length;
    return [0, ...Array.from({ length: Math.max(0, rows - 2) }, (_v, i) => i + 2)];
  }

  private columns(): number {
    return parseTable(this.source)[0].cells.length;
  }

  private focusCell(cell: HTMLElement, atEnd: boolean): void {
    cell.focus({ preventScroll: false });
    caretTo(cell, atEnd);
  }

  /** Start of the table in the current document. */
  private tableStart(): number {
    return this.view.posAtDOM(this.wrap);
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
    cell.classList.add("is-editing");
    // Show this cell's markdown while it is edited, like Obsidian.
    const text = cellText(parseTable(this.source)[ref.row], ref.col);
    if (cell.textContent !== text || cell.childElementCount > 0) {
      cell.textContent = text;
      caretTo(cell, true);
    }
    // Park the editor selection in the table so toolbar table commands apply to it.
    const row = parseTable(this.source)[ref.row];
    const span = row.cells[ref.col];
    const offset = row.offset + (span ? span.from : 0);
    queueMicrotask(() => {
      if (!this.wrap.isConnected || !this.isActive(ref)) return;
      const pos = this.tableStart() + offset;
      this.view.dispatch({ selection: { anchor: Math.min(pos, this.view.state.doc.length) } });
    });
  }

  private onFocusOut(event: FocusEvent): void {
    if (this.rebuilding) return;
    const cell = (event.target as HTMLElement).closest<HTMLElement>("th,td");
    if (!cell) return;
    cell.classList.remove("is-editing");
    const ref = this.refOf(cell);
    if (this.isActive(ref)) this.active = null;
    const text = cellText(parseTable(this.source)[ref.row], ref.col);
    cell.dataset.src = text;
    cell.innerHTML = renderCellHtml(text);
  }

  private onInput(event: Event): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("th,td");
    if (!cell) return;
    this.writeCell(this.refOf(cell), escapeCellText(cell.textContent ?? "").trim());
  }

  private writeCell(ref: CellRef, text: string): void {
    const rows = parseTable(this.source);
    const row = rows[ref.row];
    const start = this.tableStart();
    const span = row.cells[ref.col];
    if (span && row.text.slice(span.from, span.to) === text) return;
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
      this.view.dispatch({
        changes: { from: start + row.offset + span.from, to: start + row.offset + span.to, insert: text },
        userEvent: "input.type",
      });
      return;
    }
    // The row has fewer cells than the header: rewrite the whole row.
    const values = Array.from({ length: this.columns() }, (_v, c) => (c === ref.col ? text : cellText(row, c)));
    this.view.dispatch({
      changes: { from: start + row.offset, to: start + row.offset + row.text.length, insert: formatRow(values) },
      userEvent: "input.type",
    });
  }

  private addRow(focusCol: number): void {
    const rows = parseTable(this.source);
    const last = rows[rows.length - 1];
    const end = this.tableStart() + last.offset + last.text.length;
    this.pendingFocus = { row: rows.length, col: focusCol, atEnd: true };
    this.view.dispatch({
      changes: { from: end, insert: "\n" + formatRow(Array.from({ length: this.columns() }, () => "")) },
      userEvent: "input",
    });
  }

  /** Puts the editor cursor just before or after the table and focuses the editor. */
  private leave(after: boolean): void {
    const start = this.tableStart();
    const end = start + this.source.length;
    const doc = this.view.state.doc;
    let anchor: number;
    if (after) {
      if (end >= doc.length) {
        this.view.dispatch({ changes: { from: doc.length, insert: "\n" }, selection: { anchor: doc.length + 1 } });
        this.view.focus();
        return;
      }
      anchor = end + 1;
    } else {
      anchor = Math.max(0, start - 1);
    }
    this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
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
    if (cell) this.focusCell(cell, atEnd);
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
      document.execCommand("insertText", false, "<br>");
    } else if (event.key === "Enter") {
      if (isLastRow) this.addRow(ref.col);
      else this.move(ref, 1, 0, true);
    } else if (event.key === "Escape") {
      this.leave(true);
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
    } else if (mod && !event.altKey && !event.shiftKey && (event.key === "b" || event.key === "i")) {
      const marker = event.key === "b" ? "**" : "*";
      const selected = window.getSelection()?.toString() ?? "";
      document.execCommand("insertText", false, `${marker}${selected}${marker}`);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
}

function formatRow(values: string[]): string {
  return `| ${values.map((value) => value || " ").join(" | ")} |`;
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

function caretInfo(cell: HTMLElement): { atStart: boolean; atEnd: boolean } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return { atStart: false, atEnd: false };
  const range = selection.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(cell);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length;
  return { atStart: offset === 0, atEnd: offset === (cell.textContent ?? "").length };
}

const tableControllers = new WeakMap<HTMLElement, TableController>();

export class TableWidget extends SourceWidget {
  constructor(readonly source: string) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  override get estimatedHeight(): number {
    return 34 * Math.max(1, this.source.split("\n").length - 1) + 12;
  }
  toDOM(view: EditorView): HTMLElement {
    const controller = new TableController(view);
    controller.render(this.source);
    tableControllers.set(controller.wrap, controller);
    return controller.wrap;
  }
  /** Keeps the same DOM (and the focused cell) when only the table's text changed. */
  override updateDOM(dom: HTMLElement): boolean {
    const controller = tableControllers.get(dom);
    if (!controller) return false;
    controller.render(this.source);
    return true;
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
  ) {
    super();
  }
  override eq(other: MathWidget): boolean {
    return other.source === this.source && other.display === this.display;
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
  ) {
    super();
  }
  override eq(other: MermaidWidget): boolean {
    return other.source === this.source && other.dark === this.dark;
  }
  override get estimatedHeight(): number {
    return cachedMermaid(this.source, this.dark)?.height || 260;
  }
  toDOM(view: EditorView): HTMLElement {
    const host = element("div", "cm-md-mermaid");
    const cached = cachedMermaid(this.source, this.dark);
    if (cached) {
      applyRendered(view, host, cached);
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
    return host;
  }
}

/** Natural heights of loaded images, so a re-created widget does not jump. */
const imageHeights = new Map<string, number>();

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width?: number,
    readonly height?: number,
  ) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
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
    image.src = resolveImageSrc(this.src);
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
