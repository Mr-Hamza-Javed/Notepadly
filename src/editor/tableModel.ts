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
  text: string;
  cells: CellSpan[];
}

/** Rows in source order; index 1 is the delimiter row. */
export function parseTable(source: string): TableRowModel[] {
  const rows: TableRowModel[] = [];
  let offset = 0;
  for (const text of source.split("\n")) {
    rows.push({ offset, text, cells: splitRow(text) });
    offset += text.length + 1;
  }
  return rows;
}

export function cellText(row: TableRowModel, index: number): string {
  const cell = row.cells[index];
  return cell ? row.text.slice(cell.from, cell.to) : "";
}
