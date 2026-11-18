// Pipe-table parsing shared by the table widget and the table commands.
export interface CellSpan {
  /** Offsets of the trimmed cell text, relative to the start of the string given. */
  from: number;
  to: number;
}

export type Align = "left" | "center" | "right" | null;

/** Splits one table row on unescaped pipes. A pipe inside a code span still splits, as in GFM. */
export function splitRow(text: string): CellSpan[] {
  const cells: CellSpan[] = [];
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (text[i] === "|") i++;
  let start = i;
  const push = (end: number) => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    cells.push({ from, to });
  };
  for (; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
    } else if (text[i] === "|") {
      push(i);
      start = i + 1;
    }
  }
  if (text.slice(start).trim().length > 0) push(text.length);
  return cells;
}

export function parseAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

export interface TableRowModel {
  /** Offset of the row within the table source. */
  offset: number;
  /** The whole line, including any prefix. Cell spans are relative to it. */
  text: string;
  /** Blockquote/callout markers and indentation before the row (`> `), or "". */
  prefix: string;
  cells: CellSpan[];
}

const ROW_PREFIX = /^(?:[ \t]*>)*[ \t]*/;

/** Rows in source order; index 1 is the delimiter row. A table inside a quote keeps its `> ` as a prefix. */
export function parseTable(source: string): TableRowModel[] {
  const rows: TableRowModel[] = [];
  let offset = 0;
  for (const text of source.split("\n")) {
    const prefix = ROW_PREFIX.exec(text)![0];
    const cells = splitRow(text.slice(prefix.length)).map((cell) => ({
      from: cell.from + prefix.length,
      to: cell.to + prefix.length,
    }));
    rows.push({ offset, text, prefix, cells });
    offset += text.length + 1;
  }
  return rows;
}

/** Writes a row line: the prefix (with a space after a bare `>`), then the cells. */
export function joinRow(prefix: string, values: string[]): string {
  const gap = prefix.endsWith(">") ? " " : "";
  return `${prefix}${gap}| ${values.join(" | ")} |`;
}

export function cellText(row: TableRowModel, index: number): string {
  const cell = row.cells[index];
  return cell ? row.text.slice(cell.from, cell.to) : "";
}
