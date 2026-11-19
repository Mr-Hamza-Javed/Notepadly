// @vitest-environment jsdom
import { markdownView, markdownViewAt, show } from "../test/editorHarness";
import { undo } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import type { FormatCommand } from "./api";
import {
  applyFormat,
  continueMarkup,
  deleteMarkerBackward,
  formatContextAt,
  handleShiftTab,
  handleTab,
} from "./commands";

/** Applies a command to `|`-marked text and returns the result with its markers. */
function format(input: string, command: FormatCommand): string {
  const view = markdownView(input);
  applyFormat(view, command);
  return show(view);
}

function run(input: string, command: (view: ReturnType<typeof markdownView>) => boolean): [boolean, string] {
  const view = markdownView(input);
  const handled = command(view);
  return [handled, show(view)];
}

describe("bold, italic and strikethrough", () => {
  it("wraps a selection and keeps it selected", () => {
    expect(format("say |hello| now", { type: "bold" })).toBe("say **|hello|** now");
    expect(format("say |hello| now", { type: "italic" })).toBe("say *|hello|* now");
    expect(format("say |hello| now", { type: "strike" })).toBe("say ~~|hello|~~ now");
  });

  it("inserts an empty pair at a bare cursor, with the cursor inside", () => {
    expect(format("a |b", { type: "bold" })).toBe("a **|**b");
  });

  it("removes the markers when the selection is already bold", () => {
    expect(format("say **|hello|** now", { type: "bold" })).toBe("say |hello| now");
    expect(format("say **hel|lo** now", { type: "bold" })).toBe("say hel|lo now");
  });

  it("removes italic and strikethrough the same way", () => {
    expect(format("*|it|*", { type: "italic" })).toBe("|it|");
    expect(format("~~|gone|~~", { type: "strike" })).toBe("|gone|");
  });

  it("toggles back to the original text when applied twice", () => {
    const view = markdownView("x |word| y");
    applyFormat(view, { type: "bold" });
    applyFormat(view, { type: "bold" });
    expect(show(view)).toBe("x |word| y");
  });

  it("works on Urdu text and emoji", () => {
    expect(format("|سلام 😀|", { type: "bold" })).toBe("**|سلام 😀|**");
  });

  it("is a single undo step", () => {
    const view = markdownView("|text|");
    applyFormat(view, { type: "bold" });
    undo(view);
    expect(view.state.doc.toString()).toBe("text");
  });
});

describe("links", () => {
  it("turns selected text into a link and selects the url placeholder", () => {
    expect(format("see |docs| here", { type: "link" })).toBe("see [docs](|url|) here");
  });

  it("inserts a template with the text placeholder selected", () => {
    expect(format("go |", { type: "link" })).toBe("go [|text|](url)");
  });
});

describe("headings", () => {
  it("adds, changes and removes the heading marker of the cursor line", () => {
    expect(format("Ti|tle", { type: "block", kind: "h2" })).toBe("## Ti|tle");
    expect(format("### Ti|tle", { type: "block", kind: "h1" })).toBe("# Ti|tle");
    expect(format("#### Ti|tle", { type: "block", kind: "body" })).toBe("Ti|tle");
  });

  it("only touches the line the cursor is on", () => {
    expect(format("one\ntw|o\nthree", { type: "block", kind: "h3" })).toBe("one\n### tw|o\nthree");
  });

  it("does not treat a hashtag as a heading marker", () => {
    expect(format("#tag| text", { type: "block", kind: "h1" })).toBe("# #tag| text");
  });

  // Regression for BUGS.md M4 (first part): blank lines used to get "## " too.
  it("skips blank lines when a selection spans several lines", () => {
    expect(format("|one\n\ntwo|", { type: "block", kind: "h2" })).toBe("## |one\n\n## two|");
  });

  it("supports all six levels", () => {
    expect(format("x|", { type: "block", kind: "h6" })).toBe("###### x|");
  });

  // Regression: the cursor used to stay in front of the new marker, so typing
  // after choosing a heading on an empty line produced "x# " instead of "# x".
  it("puts a cursor at the start of the line after the new marker", () => {
    expect(format("|x", { type: "block", kind: "h1" })).toBe("# |x");
    expect(format("a\n|", { type: "block", kind: "h2" })).toBe("a\n## |");
  });
});

describe("lists", () => {
  it("makes the cursor line a bulleted, numbered or task item", () => {
    expect(format("it|em", { type: "list", kind: "bullet" })).toBe("- it|em");
    expect(format("it|em", { type: "list", kind: "number" })).toBe("1. it|em");
    expect(format("it|em", { type: "list", kind: "task" })).toBe("- [ ] it|em");
  });

  it("numbers several selected lines in order and skips blank ones", () => {
    expect(format("|a\n\nb\nc|", { type: "list", kind: "number" })).toBe("1. |a\n\n2. b\n3. c|");
  });

  it("removes the list when every selected line already has that kind", () => {
    expect(format("|- a\n- b|", { type: "list", kind: "bullet" })).toBe("|a\nb|");
    expect(format("- [ ] t|ask", { type: "list", kind: "task" })).toBe("t|ask");
  });

  it("converts between list kinds and keeps indentation", () => {
    expect(format("    - ne|sted", { type: "list", kind: "number" })).toBe("    1. ne|sted");
    expect(format("1. ite|m", { type: "list", kind: "bullet" })).toBe("- ite|m");
    expect(format("- [x] do|ne", { type: "list", kind: "bullet" })).toBe("- do|ne");
  });

  // Regression: same cursor placement bug as headings.
  it("can turn an empty line into a list item and type into it", () => {
    expect(format("|", { type: "list", kind: "bullet" })).toBe("- |");
    expect(format("one\n|two", { type: "list", kind: "task" })).toBe("one\n- [ ] |two");
  });
});

describe("clear formatting", () => {
  it("removes inline markers on the cursor line", () => {
    expect(format("**b** *i* ~~s~~ ==h== `c`|", { type: "clear" })).toBe("b i s h c|");
  });

  it("removes heading, quote and list markers with their space", () => {
    expect(format("## Head|", { type: "clear" })).toBe("Head|");
    expect(format("> quo|te", { type: "clear" })).toBe("quo|te");
    expect(format("- [ ] ta|sk", { type: "clear" })).toBe("ta|sk");
  });

  it("keeps link text and wikilink aliases, dropping the targets", () => {
    expect(format("[text](http://x.y)|", { type: "clear" })).toBe("text|");
    const wiki = markdownViewAt("[[Page|Alias]] and [[Other]]", 0);
    applyFormat(wiki, { type: "clear" });
    expect(wiki.state.doc.toString()).toBe("Alias and Other");
  });

  it("leaves code blocks untouched", () => {
    const text = "```\n**not bold**\n```";
    expect(format(`|${text}|`, { type: "clear" })).toBe(`|${text}|`);
  });

  it("only clears inside the selection", () => {
    expect(format("**a** |**b**|", { type: "clear" })).toBe("**a** |b|");
  });
});

describe("Enter: list and quote continuation", () => {
  it("continues bullets, tasks and quotes", () => {
    expect(run("- one|", continueMarkup)).toEqual([true, "- one\n- |"]);
    expect(run("* one|", continueMarkup)).toEqual([true, "* one\n* |"]);
    expect(run("- [x] done|", continueMarkup)).toEqual([true, "- [x] done\n- [ ] |"]);
    expect(run("> quoted|", continueMarkup)).toEqual([true, "> quoted\n> |"]);
  });

  it("increments numbered items and renumbers the items below", () => {
    expect(run("1. a|\n2. b\n3. c", continueMarkup)).toEqual([true, "1. a\n2. |\n3. b\n4. c"]);
    expect(run("3) x|", continueMarkup)).toEqual([true, "3) x\n4) |"]);
  });

  it("keeps nesting and quote prefixes", () => {
    expect(run("- a\n    - b|", continueMarkup)).toEqual([true, "- a\n    - b\n    - |"]);
    expect(run("> - in quote|", continueMarkup)).toEqual([true, "> - in quote\n> - |"]);
  });

  it("ends the list on Enter in an empty item", () => {
    expect(run("- a\n- |", continueMarkup)).toEqual([true, "- a\n|"]);
    expect(run("> a\n> |", continueMarkup)).toEqual([true, "> a\n|"]);
  });

  it("splits an item when Enter is pressed in the middle", () => {
    expect(run("- ab|cd", continueMarkup)).toEqual([true, "- ab\n- |cd"]);
  });

  it("leaves Enter to the default handler outside lists and inside code", () => {
    expect(run("plain|", continueMarkup)[0]).toBe(false);
    expect(run("```\n- not a list|\n```", continueMarkup)[0]).toBe(false);
    expect(run("|- a", continueMarkup)[0]).toBe(false);
  });

  it("does not continue a line that only looks like a list item inside a paragraph", () => {
    expect(run("a paragraph\n1980. was a year|", continueMarkup)[0]).toBe(false);
  });
});

describe("Backspace after an empty list marker", () => {
  it("removes the marker and keeps the indent", () => {
    expect(run("- a\n- |", deleteMarkerBackward)).toEqual([true, "- a\n|"]);
    expect(run("- a\n    - |", deleteMarkerBackward)).toEqual([true, "- a\n    |"]);
  });

  it("does nothing when the item has text or the cursor is elsewhere", () => {
    expect(run("- a|", deleteMarkerBackward)[0]).toBe(false);
    expect(run("|- ", deleteMarkerBackward)[0]).toBe(false);
  });
});

describe("Tab and Shift+Tab", () => {
  it("indents and outdents list items", () => {
    expect(run("- a\n- b|", handleTab)).toEqual([true, "- a\n    - b|"]);
    expect(run("- a\n    - b|", handleShiftTab)).toEqual([true, "- a\n- b|"]);
  });

  it("indents every selected list line", () => {
    expect(run("|- a\n- b|", handleTab)[1]).toBe("    |- a\n    - b|");
  });

  it("inserts a tab character in ordinary text", () => {
    expect(run("ab|", handleTab)).toEqual([true, "ab\t|"]);
  });
});

describe("tables", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";

  it("Tab moves to the next cell and selects its text, skipping the delimiter row", () => {
    const view = markdownViewAt(table, 2);
    expect(handleTab(view)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("b");
    handleTab(view);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("1");
  });

  it("Shift+Tab moves back to the previous cell", () => {
    const view = markdownViewAt(table, table.indexOf("2"));
    handleShiftTab(view);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("1");
  });

  it("Tab in the last cell adds a new row", () => {
    const view = markdownViewAt(table, table.length - 2);
    handleTab(view);
    expect(view.state.doc.toString()).toBe(`${table}\n|   |   |`);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
  });

  it("inserts a table on an empty document with the first header selected", () => {
    const view = markdownViewAt("", 0);
    applyFormat(view, { type: "table-insert", rows: 2, cols: 2 });
    expect(view.state.doc.toString()).toBe("| Header 1 | Header 2 |\n| --- | --- |\n|   |   |\n");
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe("Header 1");
  });

  it("inserts a table after the current line, separated by a blank line", () => {
    const view = markdownViewAt("text", 4);
    applyFormat(view, { type: "table-insert", rows: 1, cols: 1 });
    expect(view.state.doc.toString()).toBe("text\n\n| Header 1 |\n| --- |");
  });

  // Regression for BUGS.md H4: the paragraph below used to become the table's last row.
  it("keeps a blank line between an inserted table and the paragraph below", () => {
    const text = "first\n\nsecond paragraph";
    const view = markdownViewAt(text, 6);
    applyFormat(view, { type: "table-insert", rows: 2, cols: 2 });
    expect(view.state.doc.toString()).toBe(
      "first\n\n| Header 1 | Header 2 |\n| --- | --- |\n|   |   |\n\nsecond paragraph",
    );
    const after = markdownViewAt("text\nnext", 4);
    applyFormat(after, { type: "table-insert", rows: 1, cols: 1 });
    expect(after.state.doc.toString()).toBe("text\n\n| Header 1 |\n| --- |\n\nnext");
  });

  it("does not add a second blank line when one already follows", () => {
    const view = markdownViewAt("\n\nlater", 0);
    applyFormat(view, { type: "table-insert", rows: 1, cols: 1 });
    expect(view.state.doc.toString()).toBe("| Header 1 |\n| --- |\n\nlater");
  });

  it("does not nest a table inside a table", () => {
    const view = markdownViewAt(table, 2);
    applyFormat(view, { type: "table-insert", rows: 2, cols: 2 });
    expect(view.state.doc.toString()).toBe(table);
  });

  it("adds rows above and below, never above the header", () => {
    const below = markdownViewAt(table, table.indexOf("1"));
    applyFormat(below, { type: "table-edit", op: "row-below" });
    expect(below.state.doc.toString()).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |");

    const header = markdownViewAt(table, 2);
    applyFormat(header, { type: "table-edit", op: "row-above" });
    expect(header.state.doc.toString()).toBe("| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |");
  });

  it("adds and deletes columns, keeping the delimiter row valid", () => {
    const view = markdownViewAt(table, 2);
    applyFormat(view, { type: "table-edit", op: "col-right" });
    expect(view.state.doc.toString()).toBe("| a |  | b |\n| --- | --- | --- |\n| 1 |  | 2 |");
    applyFormat(view, { type: "table-edit", op: "del-col" });
    expect(view.state.doc.toString()).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("deletes a body row but never the header", () => {
    const body = markdownViewAt(table, table.indexOf("2"));
    applyFormat(body, { type: "table-edit", op: "del-row" });
    expect(body.state.doc.toString()).toBe("| a | b |\n| --- | --- |");

    const header = markdownViewAt(table, 2);
    applyFormat(header, { type: "table-edit", op: "del-row" });
    expect(header.state.doc.toString()).toBe(table);
  });

  it("refuses to delete the last remaining column", () => {
    const single = "| a |\n| --- |\n| 1 |";
    const view = markdownViewAt(single, 2);
    applyFormat(view, { type: "table-edit", op: "del-col" });
    expect(view.state.doc.toString()).toBe(single);
  });

  it("deletes the whole table and its line break", () => {
    const text = `before\n\n${table}\n\nafter`;
    const view = markdownViewAt(text, text.indexOf("1"));
    applyFormat(view, { type: "table-edit", op: "del-table" });
    expect(view.state.doc.toString()).toBe("before\n\n\nafter");
  });

  it("treats a pipe-less line right after a table as one more row, as GFM does", () => {
    const text = `${table}\nafter`;
    const view = markdownViewAt(text, text.indexOf("1"));
    applyFormat(view, { type: "table-edit", op: "del-table" });
    expect(view.state.doc.toString()).toBe("");
  });

  it("keeps escaped pipes and unicode inside cells when editing", () => {
    const text = "| a \\| b | سلام |\n| --- | --- |\n| 😀 | x |";
    const view = markdownViewAt(text, text.indexOf("x"));
    applyFormat(view, { type: "table-edit", op: "row-below" });
    expect(view.state.doc.toString()).toBe("| a \\| b | سلام |\n| --- | --- |\n| 😀 | x |\n|  |  |");
  });

  // Regression for BUGS.md H5: table commands parsed the "> " prefix as part of the row.
  it("H5: adding a row to a table inside a blockquote keeps it in the quote", () => {
    const text = "> | a | b |\n> | --- | --- |\n> | 1 | 2 |";
    const view = markdownViewAt(text, text.indexOf("1"));
    applyFormat(view, { type: "table-edit", op: "row-below" });
    expect(view.state.doc.toString()).toBe(`${text}\n> |  |  |`);
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("> |  |  |");
  });

  it("edits columns of a table in a callout and Tab adds a quoted row", () => {
    const text = "> [!note]\n> | a | b |\n> | --- | --- |\n> | 1 | 2 |";
    const view = markdownViewAt(text, text.indexOf("2"));
    applyFormat(view, { type: "table-edit", op: "del-col" });
    expect(view.state.doc.toString()).toBe("> [!note]\n> | a |\n> | --- |\n> | 1 |");
    const tab = markdownViewAt(text, text.indexOf("2"));
    handleTab(tab);
    expect(tab.state.doc.toString()).toBe(`${text}\n> |   |   |`);
    expect(tab.state.selection.main.head).toBe(tab.state.doc.length - "|   |   |".length + 2);
  });

  // Regression for BUGS.md L10: cells past the header's width were dropped.
  it("L10: table commands keep the extra cells of a long row", () => {
    const text = "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |";
    const view = markdownViewAt(text, text.indexOf("a"));
    applyFormat(view, { type: "table-edit", op: "row-below" });
    expect(view.state.doc.toString()).toBe("| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 | 3 |");
    applyFormat(view, { type: "table-edit", op: "col-left" });
    expect(view.state.doc.line(4).text).toBe("|  | 1 | 2 | 3 |");
  });

  it("table edit commands do nothing outside a table", () => {
    const view = markdownViewAt("just text", 3);
    applyFormat(view, { type: "table-edit", op: "del-table" });
    expect(view.state.doc.toString()).toBe("just text");
  });
});

describe("known open bugs (see BUGS.md)", () => {
  // BUGS.md M4 (second part): bold across a paragraph break is not bold markdown.
  it("M4: bolding two paragraphs bolds each one", () => {
    expect(format("|one\n\ntwo|", { type: "bold" })).toBe("**|one**\n\n**two|**");
    expect(format("a |one\n  \n\ntwo\nthree| b", { type: "italic" })).toBe("a *|one*\n  \n\n*two\nthree|* b");
    // The selection becomes the wrapped text, so a second toggle removes the markers again.
    expect(format("|one\n\n|two", { type: "strike" })).toBe("~~|one|~~\n\ntwo");
    // A soft line break inside one paragraph is still wrapped as a whole.
    expect(format("|one\ntwo|", { type: "bold" })).toBe("**|one\ntwo|**");
  });
});

describe("EDIT-3: inline markers across list items, quotes, headings and spaces", () => {
  it("puts the markers inside selected spaces, where Markdown reads them", () => {
    expect(format("|hello |world", { type: "bold" })).toBe("**|hello|** world");
    expect(format("a| b |c", { type: "italic" })).toBe("a *|b|* c");
  });

  it("wraps each list item, quote line or heading after its marker", () => {
    expect(format("|- one\n- two|", { type: "bold" })).toBe("|- **one**\n- **two|**");
    expect(format("|> one\n> two|", { type: "bold" })).toBe("|> **one**\n> **two|**");
    expect(format("|1. one\n2. [ ] two|", { type: "strike" })).toBe("|1. ~~one~~\n2. [ ] ~~two|~~");
    expect(format("|# one\n## two|", { type: "italic" })).toBe("|# *one*\n## *two|*");
  });

  it("removes the markers again on a second toggle", () => {
    for (const input of ["|- one\n- two|", "|one\n\ntwo|", "|hello |world"]) {
      const view = markdownView(input);
      const before = view.state.doc.toString();
      applyFormat(view, { type: "bold" });
      applyFormat(view, { type: "bold" });
      expect(view.state.doc.toString(), input).toBe(before);
    }
  });
});

describe("toolbar context", () => {
  const contextOf = (input: string) => formatContextAt(markdownView(input).state);

  it("reports headings and plain body", () => {
    expect(contextOf("## Ti|tle").block).toBe("h2");
    expect(contextOf("Title\n===|").block).toBe("h1");
    expect(contextOf("just| text").block).toBe("body");
  });

  it("reports inline formatting around the cursor", () => {
    expect(contextOf("**bo|ld**")).toMatchObject({ bold: true, italic: false });
    expect(contextOf("*it|*")).toMatchObject({ italic: true, bold: false });
    expect(contextOf("~~s|~~").strike).toBe(true);
    expect(contextOf("[li|nk](u)").link).toBe(true);
    expect(contextOf("[[wi|ki]]").link).toBe(true);
  });

  it("reports the list kind of the cursor line", () => {
    expect(contextOf("- it|em").list).toBe("bullet");
    expect(contextOf("1. it|em").list).toBe("number");
    expect(contextOf("- [ ] it|em").list).toBe("task");
    expect(contextOf("not a li|st").list).toBe("none");
  });

  it("reports when the cursor is in a table", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(formatContextAt(markdownViewAt(table, 2).state).inTable).toBe(true);
    expect(formatContextAt(markdownViewAt(`${table}\n\nafter`, table.length + 3).state).inTable).toBe(false);
  });
});
