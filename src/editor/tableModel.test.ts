import { describe, expect, it } from "vitest";
import { cellText, parseAlign, parseTable, splitRow } from "./tableModel";
import { escapeCellText, renderCellHtml } from "./livePreview/widgets";

describe("table rows", () => {
  it("splits cells on unescaped pipes and trims them", () => {
    const row = "| a |  b c | \\| d |";
    expect(splitRow(row).map((c) => row.slice(c.from, c.to))).toEqual(["a", "b c", "\\| d"]);
  });

  it("handles rows without outer pipes", () => {
    const row = "x | y";
    expect(splitRow(row).map((c) => row.slice(c.from, c.to))).toEqual(["x", "y"]);
  });

  it("reads alignment from the delimiter row", () => {
    expect(parseAlign(":---")).toBe("left");
    expect(parseAlign(":--:")).toBe("center");
    expect(parseAlign("---:")).toBe("right");
    expect(parseAlign("---")).toBeNull();
  });

  it("keeps row offsets so cells map back to the document", () => {
    const source = "| H1 | H2 |\n| --- | --- |\n| a | b |";
    const rows = parseTable(source);
    expect(rows).toHaveLength(3);
    const body = rows[2];
    const cell = body.cells[1];
    expect(source.slice(body.offset + cell.from, body.offset + cell.to)).toBe("b");
    expect(cellText(body, 5)).toBe("");
  });
});

describe("malformed and unusual tables", () => {
  const cells = (row: string) => splitRow(row).map((c) => row.slice(c.from, c.to));

  it("keeps empty cells between pipes", () => {
    expect(cells("| a |  | c |")).toEqual(["a", "", "c"]);
    expect(cells("|||")).toEqual(["", ""]);
  });

  it("ignores indentation and a missing closing pipe", () => {
    expect(cells("   | a | b")).toEqual(["a", "b"]);
    expect(cells("\t|a|b|")).toEqual(["a", "b"]);
  });

  it("returns no cells for an empty or blank row", () => {
    expect(cells("")).toEqual([]);
    expect(cells("   ")).toEqual([]);
    expect(cells("|")).toEqual([]);
  });

  it("does not split on an escaped pipe at the end of a cell", () => {
    expect(cells("| a\\| | b |")).toEqual(["a\\|", "b"]);
  });

  it("splits a pipe inside a code span, as GFM does", () => {
    expect(cells("| `a|b` | c |")).toEqual(["`a", "b`", "c"]);
  });

  it("keeps Urdu and emoji cells intact", () => {
    expect(cells("| سلام | 😀 |")).toEqual(["سلام", "😀"]);
  });

  it("reads alignment with surrounding spaces and odd lengths", () => {
    expect(parseAlign(":-")).toBe("left");
    expect(parseAlign(":")).toBe("center");
    expect(parseAlign("")).toBeNull();
  });

  it("parses a table with a single header row", () => {
    const rows = parseTable("| only |");
    expect(rows).toHaveLength(1);
    expect(cellText(rows[0], 0)).toBe("only");
    expect(cellText(rows[0], 3)).toBe("");
  });
});

describe("in-place cell editing", () => {
  it("keeps already escaped pipes and unicode as they are", () => {
    expect(escapeCellText("سلام | 😀")).toBe("سلام \\| 😀");
    expect(escapeCellText("a\r\nb")).toBe("a b");
  });

  it("escapes typed pipes and drops line breaks", () => {
    expect(escapeCellText("a|b")).toBe("a\\|b");
    expect(escapeCellText("a\\|b")).toBe("a\\|b");
    expect(escapeCellText("one\ntwo")).toBe("one two");
  });
});

describe("cell rendering", () => {
  it("renders markdown and simple inline HTML", () => {
    expect(renderCellHtml("**b** *i* ~~s~~ ==h== `c`")).toBe(
      "<strong>b</strong> <em>i</em> <s>s</s> <mark>h</mark> <code>c</code>",
    );
    expect(renderCellHtml("<kbd>Ctrl</kbd>+<kbd>S</kbd>")).toBe("<kbd>Ctrl</kbd>+<kbd>S</kbd>");
  });

  it("renders links as inert anchors whose target cannot break out of the attribute", () => {
    expect(renderCellHtml("[docs](https://x.y)")).toBe('<a data-href="https://x.y">docs</a>');
    const html = renderCellHtml('[x](a"onmouseover=alert(1))');
    expect(html).not.toMatch(/"\s*onmouseover/);
    expect(html).toContain("&quot;");
  });

  it("keeps markdown inside code spans literal", () => {
    expect(renderCellHtml("`**not bold**` **bold**")).toBe("<code>**not bold**</code> <strong>bold</strong>");
  });

  it("turns escaped pipes back into pipes and keeps <br>", () => {
    expect(renderCellHtml("a \\| b<br>c")).toBe("a | b<br>c");
  });

  it("escapes ampersands and angle brackets in plain text", () => {
    expect(renderCellHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("renders an empty cell as nothing", () => {
    expect(renderCellHtml("")).toBe("");
  });

  // BUGS.md L8: arithmetic in a cell turns italic.
  it.skip("L8: 2 * 3 * 4 stays plain text", () => {
    expect(renderCellHtml("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("never lets a cell inject attributes or scripts", () => {
    const html = renderCellHtml('<img src=x onerror="alert(1)"><script>x</script><kbd onclick="x">k</kbd>');
    // Disallowed tags stay escaped text, and no real tag carries attributes.
    expect(html).not.toMatch(/<(img|script)/i);
    expect(html).not.toMatch(/<[a-z]+\s[^>]*>/i);
    expect(html).toContain("&lt;img");
  });
});
