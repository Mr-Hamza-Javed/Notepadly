// Markdown formatting commands, list continuation, and table editing.
import { indentLess, insertTab } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
} from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { BlockKind, FormatCommand, FormatContext, ListKind } from "./api";
import { cellText, parseTable, type TableRowModel } from "./tableModel";

const LIST_LINE = /^(\s*)([-+*]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
const QUOTE_LIST_LINE = /^(\s*(?:>\s?)*)(\s*)([-+*]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;
const QUOTE_ONLY = /^(\s*(?:>\s?)+)(.*)$/;
const NO_CONTINUE = ["FencedCode", "CodeBlock", "BlockMath", "CommentBlock", "Frontmatter", "HTMLBlock", "Table"];
const INDENT = "    ";

function ancestorOf(node: SyntaxNode | null, names: readonly string[]): SyntaxNode | null {
  for (let current = node; current; current = current.parent) {
    if (names.includes(current.name)) return current;
  }
  return null;
}

function nodeAround(state: EditorState, pos: number, names: readonly string[]): SyntaxNode | null {
  const tree = syntaxTree(state);
  return ancestorOf(tree.resolveInner(pos, -1), names) ?? ancestorOf(tree.resolveInner(pos, 1), names);
}

function selectedLines(state: EditorState, range: SelectionRange): Line[] {
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const lines: Line[] = [];
  for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n));
  return lines;
}

// ---------- Inline toggles ----------

function toggleInline(view: EditorView, marker: string, nodeName: string, markName: string): void {
  const { state } = view;
  const tree = syntaxTree(state);
  const size = marker.length;
  view.dispatch(
    state.changeByRange((range) => {
      const enclosing =
        ancestorOf(tree.resolveInner(range.from, 1), [nodeName]) ??
        ancestorOf(tree.resolveInner(range.from, -1), [nodeName]);
      if (enclosing && enclosing.from <= range.from && enclosing.to >= range.to) {
        const marks = enclosing.getChildren(markName);
        if (marks.length >= 2) {
          const open = marks[0];
          const close = marks[marks.length - 1];
          const changes = [
            { from: open.from, to: open.to },
            { from: close.from, to: close.to },
          ];
          const mapPos = (pos: number) => {
            let mapped = pos;
            if (pos >= open.to) mapped -= open.to - open.from;
            else if (pos > open.from) mapped -= pos - open.from;
            if (pos >= close.to) mapped -= close.to - close.from;
            else if (pos > close.from) mapped -= pos - close.from;
            return mapped;
          };
          return { changes, range: EditorSelection.range(mapPos(range.anchor), mapPos(range.head)) };
        }
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.anchor + size, range.head + size),
      };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
}

function formatLink(view: EditorView): void {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      if (text) {
        const urlFrom = range.from + text.length + 3;
        return {
          changes: { from: range.from, to: range.to, insert: `[${text}](url)` },
          range: EditorSelection.range(urlFrom, urlFrom + 3),
        };
      }
      return {
        changes: { from: range.from, insert: "[text](url)" },
        range: EditorSelection.range(range.from + 1, range.from + 5),
      };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
}

// ---------- Block and list formatting ----------

function setBlockKind(view: EditorView, kind: BlockKind): void {
  const { state } = view;
  const prefix = kind === "body" ? "" : `${"#".repeat(Number(kind.slice(1)))} `;
  const changes: ChangeSpec[] = [];
  for (const range of state.selection.ranges) {
    for (const line of selectedLines(state, range)) {
      const existing = /^#{1,6}[ \t]+/.exec(line.text);
      changes.push({ from: line.from, to: line.from + (existing ? existing[0].length : 0), insert: prefix });
    }
  }
  view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
}

function lineListKind(text: string): ListKind {
  const match = LIST_LINE.exec(text);
  if (!match) return "none";
  if (match[4]) return "task";
  return /\d/.test(match[2]) ? "number" : "bullet";
}

function setListKind(view: EditorView, kind: ListKind): void {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  for (const range of state.selection.ranges) {
    const lines = selectedLines(state, range);
    const candidates = lines.filter((line) => line.text.trim() || lines.length === 1);
    const target: ListKind =
      kind !== "none" && candidates.every((line) => lineListKind(line.text) === kind) ? "none" : kind;
    let number = 1;
    for (const line of candidates) {
      const match = LIST_LINE.exec(line.text);
      const indent = match ? match[1] : /^\s*/.exec(line.text)![0];
      const consumed = match ? match[0].length : indent.length;
      let marker = "";
      if (target === "bullet") marker = "- ";
      else if (target === "task") marker = "- [ ] ";
      else if (target === "number") marker = `${number++}. `;
      changes.push({ from: line.from, to: line.from + consumed, insert: indent + marker });
    }
  }
  view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
}

function clearFormatting(view: EditorView): void {
  const { state } = view;
  const tree = syntaxTree(state);
  const changes: ChangeSpec[] = [];
  const remove = (from: number, to: number) => changes.push({ from, to });
  const withSpace = (from: number, to: number) =>
    remove(from, state.sliceDoc(to, to + 1) === " " ? to + 1 : to);

  for (const range of state.selection.ranges) {
    const from = range.empty ? state.doc.lineAt(range.from).from : range.from;
    const to = range.empty ? state.doc.lineAt(range.to).to : range.to;
    tree.iterate({
      from,
      to,
      enter: (node) => {
        switch (node.name) {
          case "EmphasisMark":
          case "StrikethroughMark":
          case "HighlightMark":
            remove(node.from, node.to);
            return false;
          case "CodeMark":
            if (node.node.parent?.name === "InlineCode") remove(node.from, node.to);
            return false;
          case "HeaderMark":
          case "QuoteMark":
          case "ListMark":
          case "TaskMarker":
            withSpace(node.from, node.to);
            return false;
          case "Link": {
            const marks = node.node.getChildren("LinkMark");
            if (marks.length >= 2) {
              remove(node.from, marks[0].to);
              remove(marks[1].from, node.to);
            }
            return true;
          }
          case "WikiLink": {
            const target = node.node.getChild("WikiAlias") ?? node.node.getChild("WikiTarget");
            if (target) {
              remove(node.from, target.from);
              remove(target.to, node.to);
            }
            return false;
          }
          case "FencedCode":
          case "CodeBlock":
          case "Table":
          case "BlockMath":
          case "Frontmatter":
            return false;
        }
        return true;
      },
    });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
}

// ---------- Tables ----------

interface TableLocation {
  from: number;
  to: number;
  rows: TableRowModel[];
  rowIndex: number;
  column: number;
}

function locateTable(state: EditorState, pos: number): TableLocation | null {
  const node = nodeAround(state, pos, ["Table"]);
  if (!node) return null;
  const from = state.doc.lineAt(node.from).from;
  const to = state.doc.lineAt(node.to).to;
  const rows = parseTable(state.sliceDoc(from, to));
  const rowIndex = state.doc.lineAt(pos).number - state.doc.lineAt(from).number;
  const row = rows[rowIndex];
  if (!row) return null;
  const offset = pos - from - row.offset;
  let column = 0;
  for (let c = 0; c < row.cells.length; c++) {
    const nextCell = row.cells[c + 1];
    column = c;
    if (!nextCell || offset <= row.cells[c].to + 1) break;
    if (offset < nextCell.from - 1) break;
  }
  return { from, to, rows, rowIndex, column };
}

function moveToCell(view: EditorView, location: TableLocation, rowIndex: number, column: number): void {
  const row = location.rows[rowIndex];
  const cell = row.cells[column];
  if (!cell) return;
  const base = location.from + row.offset;
  view.dispatch({
    selection: EditorSelection.range(base + cell.from, base + cell.to),
    scrollIntoView: true,
    userEvent: "select",
  });
}

function emptyRow(columns: number): string {
  return `|${"   |".repeat(columns)}`;
}

function tableTab(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  if (!state.selection.main.empty && state.doc.lineAt(state.selection.main.from).number !== state.doc.lineAt(state.selection.main.to).number) {
    return false;
  }
  const location = locateTable(state, state.selection.main.head);
  if (!location) return false;
  const { rows } = location;
  const columns = rows[0].cells.length;
  let row = location.rowIndex;
  let column = location.column + dir;
  if (column >= columns) {
    column = 0;
    row++;
  } else if (column < 0) {
    column = columns - 1;
    row--;
  }
  if (row === 1) row += dir;
  if (row < 0) return true;
  if (row >= rows.length) {
    const insert = `\n${emptyRow(columns)}`;
    const anchor = location.to + 3;
    view.dispatch({
      changes: { from: location.to, insert },
      selection: { anchor },
      scrollIntoView: true,
      userEvent: "input.table",
    });
    return true;
  }
  moveToCell(view, location, row, column);
  return true;
}

function insertTable(view: EditorView, rows: number, cols: number): void {
  const { state } = view;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const headers = Array.from({ length: cols }, (_v, i) => ` Header ${i + 1} `);
  const body = [
    `|${headers.join("|")}|`,
    `|${headers.map(() => " --- ").join("|")}|`,
    ...Array.from({ length: Math.max(0, rows - 1) }, () => emptyRow(cols)),
  ].join("\n");

  const previous = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const atBlankLine = line.text.trim() === "";
  const from = atBlankLine ? line.from : line.to;
  let prefix = "";
  if (!atBlankLine) prefix = "\n\n";
  else if (previous && previous.text.trim() !== "") prefix = "\n";
  const hasNext = line.number < state.doc.lines;
  const suffix = hasNext && (atBlankLine ? false : state.doc.line(line.number + 1).text.trim() !== "") ? "\n" : atBlankLine && !hasNext ? "\n" : "";

  const cellFrom = from + prefix.length + 2;
  view.dispatch({
    changes: { from, to: atBlankLine ? line.to : from, insert: prefix + body + suffix },
    selection: EditorSelection.range(cellFrom, cellFrom + "Header 1".length),
    scrollIntoView: true,
    userEvent: "input.table",
  });
}

function editTable(view: EditorView, op: Extract<FormatCommand, { type: "table-edit" }>["op"]): void {
  const { state } = view;
  const location = locateTable(state, state.selection.main.head);
  if (!location) return;
  const { rows, from, to } = location;
  const columns = rows[0].cells.length;
  let grid = rows.map((row) => Array.from({ length: columns }, (_v, c) => cellText(row, c)));
  let rowIndex = location.rowIndex;
  let column = location.column;

  if (op === "del-table") {
    const docEnd = state.doc.length;
    view.dispatch({
      changes: { from, to: to < docEnd ? to + 1 : to },
      selection: { anchor: from },
      userEvent: "delete.table",
    });
    return;
  }

  switch (op) {
    case "row-above": {
      const at = Math.max(2, rowIndex);
      grid.splice(at, 0, Array(columns).fill(""));
      rowIndex = at;
      break;
    }
    case "row-below": {
      const at = Math.max(2, rowIndex + 1);
      grid.splice(at, 0, Array(columns).fill(""));
      rowIndex = at;
      break;
    }
    case "del-row":
      if (rowIndex < 2) return;
      grid.splice(rowIndex, 1);
      rowIndex = Math.min(rowIndex, grid.length - 1);
      break;
    case "col-left":
    case "col-right": {
      const at = op === "col-left" ? column : column + 1;
      grid = grid.map((row, r) => {
        const next = row.slice();
        next.splice(at, 0, r === 1 ? "---" : "");
        return next;
      });
      column = at;
      break;
    }
    case "del-col":
      if (columns <= 1) return;
      grid = grid.map((row) => row.filter((_cell, c) => c !== column));
      column = Math.min(column, columns - 2);
      break;
  }

  const lines = grid.map((row) => `| ${row.join(" | ")} |`);
  const text = lines.join("\n");
  let anchor = from;
  for (let r = 0; r < rowIndex && r < lines.length; r++) anchor += lines[r].length + 1;
  anchor += 2;
  const targetRow = grid[Math.min(rowIndex, grid.length - 1)];
  for (let c = 0; c < column && c < targetRow.length; c++) anchor += targetRow[c].length + 3;

  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor },
    scrollIntoView: true,
    userEvent: "input.table",
  });
}

// ---------- Key handlers ----------

function renumberFollowing(state: EditorState, line: Line, indent: string, start: number): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let number = start;
  for (let n = line.number + 1, scanned = 0; n <= state.doc.lines && scanned < 500; n++, scanned++) {
    const next = state.doc.line(n);
    const match = /^(\s*)(\d+)([.)])/.exec(next.text);
    if (!match) {
      if (next.text.trim() === "" || next.text.startsWith(`${indent} `)) continue;
      break;
    }
    if (match[1].length > indent.length) continue;
    if (match[1] !== indent) break;
    if (Number(match[2]) !== number) {
      const numFrom = next.from + match[1].length;
      changes.push({ from: numFrom, to: numFrom + match[2].length, insert: String(number) });
    }
    number++;
  }
  return changes;
}

export const continueMarkup: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (nodeAround(state, range.head, NO_CONTINUE)) return false;
  const line = state.doc.lineAt(range.head);

  const list = QUOTE_LIST_LINE.exec(line.text);
  if (list) {
    const [, quote, indent, marker, gap, task, rest] = list;
    const contentStart = line.from + line.text.length - rest.length;
    if (range.head < contentStart || !nodeAround(state, range.head, ["ListItem"])) return false;
    if (!rest.trim() && range.empty) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: quote },
        selection: { anchor: line.from + quote.length },
        scrollIntoView: true,
        userEvent: "delete.list",
      });
      return true;
    }
    const numeric = /^(\d+)([.)])$/.exec(marker);
    const nextNumber = numeric ? Number(numeric[1]) + 1 : 0;
    const nextMarker = numeric ? `${nextNumber}${numeric[2]}` : marker;
    const insert = `\n${quote}${indent}${nextMarker}${gap}${task ? "[ ] " : ""}`;
    const changes: ChangeSpec[] = [{ from: range.from, to: range.to, insert }];
    if (numeric) changes.push(...renumberFollowing(state, line, indent, nextNumber + 1));
    view.dispatch({
      changes,
      selection: { anchor: range.from + insert.length },
      scrollIntoView: true,
      userEvent: "input.type",
    });
    return true;
  }

  const quoted = QUOTE_ONLY.exec(line.text);
  if (quoted && range.head >= line.from + quoted[1].length && nodeAround(state, range.head, ["Blockquote"])) {
    if (!quoted[2].trim() && range.empty) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
        scrollIntoView: true,
        userEvent: "delete.list",
      });
      return true;
    }
    const insert = `\n${quoted[1]}`;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + insert.length },
      scrollIntoView: true,
      userEvent: "input.type",
    });
    return true;
  }
  return false;
};

/** Backspace directly after an empty item's marker removes the marker. */
export const deleteMarkerBackward: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1 || !range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const match = LIST_LINE.exec(line.text);
  if (!match || line.from + match[0].length !== range.head || line.text.length !== match[0].length) return false;
  if (!nodeAround(state, range.head, ["ListItem"])) return false;
  view.dispatch({
    changes: { from: line.from + match[1].length, to: range.head },
    userEvent: "delete.backward",
  });
  return true;
};

function indentListLines(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const lines = state.selection.ranges.flatMap((range) => selectedLines(state, range));
  if (!lines.some((line) => LIST_LINE.test(line.text))) return false;
  if (!nodeAround(state, state.selection.main.head, ["ListItem"])) return false;
  const changes: ChangeSpec[] = [];
  for (const line of lines) {
    if (!LIST_LINE.test(line.text)) continue;
    if (dir === 1) {
      changes.push({ from: line.from, insert: INDENT });
    } else {
      const leading = /^( {1,4}|\t)/.exec(line.text);
      if (leading) changes.push({ from: line.from, to: line.from + leading[0].length });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: dir === 1 ? "input.indent" : "delete.dedent" });
  return true;
}

export const handleTab: Command = (view) => tableTab(view, 1) || indentListLines(view, 1) || insertTab(view);
export const handleShiftTab: Command = (view) =>
  tableTab(view, -1) || indentListLines(view, -1) || indentLess(view);

// ---------- Entry points ----------

export function applyFormat(view: EditorView, command: FormatCommand): void {
  switch (command.type) {
    case "bold":
      toggleInline(view, "**", "StrongEmphasis", "EmphasisMark");
      break;
    case "italic":
      toggleInline(view, "*", "Emphasis", "EmphasisMark");
      break;
    case "strike":
      toggleInline(view, "~~", "Strikethrough", "StrikethroughMark");
      break;
    case "link":
      formatLink(view);
      break;
    case "clear":
      clearFormatting(view);
      break;
    case "block":
      setBlockKind(view, command.kind);
      break;
    case "list":
      setListKind(view, command.kind);
      break;
    case "table-insert":
      insertTable(view, command.rows, command.cols);
      break;
    case "table-edit":
      editTable(view, command.op);
      break;
  }
}

/** Walks only the ancestors of the cursor, so its cost does not depend on document size. */
export function formatContextAt(state: EditorState): FormatContext {
  const context: FormatContext = {
    block: "body",
    list: "none",
    bold: false,
    italic: false,
    strike: false,
    link: false,
    inTable: false,
  };
  const tree = syntaxTree(state);
  const { head } = state.selection.main;
  const line = state.doc.lineAt(head);

  const inspect = (start: SyntaxNode) => {
    for (let node: SyntaxNode | null = start; node; node = node.parent) {
      switch (node.name) {
        case "StrongEmphasis":
          context.bold = true;
          break;
        case "Emphasis":
          context.italic = true;
          break;
        case "Strikethrough":
          context.strike = true;
          break;
        case "Link":
        case "WikiLink":
        case "Autolink":
          context.link = true;
          break;
        case "Table":
          context.inTable = true;
          break;
      }
    }
  };
  inspect(tree.resolveInner(head, -1));
  inspect(tree.resolveInner(head, 1));

  const contentStart = line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0);
  for (let node: SyntaxNode | null = tree.resolveInner(contentStart, 1); node; node = node.parent) {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
    if (heading) {
      context.block = `h${heading[1]}` as BlockKind;
    } else if (node.name === "ListItem" && context.list === "none") {
      if (node.getChild("Task")) context.list = "task";
      else context.list = node.parent?.name === "OrderedList" ? "number" : "bullet";
    }
  }
  return context;
}
