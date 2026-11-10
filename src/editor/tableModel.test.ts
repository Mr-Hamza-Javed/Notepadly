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

describe("in-place cell editing", () => {
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

  it("never lets a cell inject attributes or scripts", () => {
    const html = renderCellHtml('<img src=x onerror="alert(1)"><script>x</script><kbd onclick="x">k</kbd>');
    // Disallowed tags stay escaped text, and no real tag carries attributes.
    expect(html).not.toMatch(/<(img|script)/i);
    expect(html).not.toMatch(/<[a-z]+\s[^>]*>/i);
    expect(html).toContain("&lt;img");
  });
});
