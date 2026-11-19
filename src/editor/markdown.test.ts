import { readFileSync } from "node:fs";
import { TreeFragment, type Tree } from "@lezer/common";
import { describe, expect, it } from "vitest";
import { notepadlyParser, plainMarkdownParser } from "./markdown";

const sample = readFileSync(new URL("../../sample.md", import.meta.url), "utf8").replace(/\r\n?/g, "\n");

function nodeNames(tree: Tree): Set<string> {
  const names = new Set<string>();
  tree.iterate({ enter: (node) => void names.add(node.name) });
  return names;
}

describe("markdown parser", () => {
  it("recognises every feature used in sample.md", () => {
    const names = nodeNames(plainMarkdownParser.parse(sample));
    for (const expected of [
      "Frontmatter",
      "ATXHeading1",
      "SetextHeading1",
      "StrongEmphasis",
      "Emphasis",
      "Strikethrough",
      "Highlight",
      "InlineCode",
      "Link",
      "Autolink",
      "WikiLink",
      "Embed",
      "Image",
      "BulletList",
      "OrderedList",
      "Task",
      "Blockquote",
      "CalloutTag",
      "HorizontalRule",
      "FencedCode",
      "CodeBlock",
      "Table",
      "InlineMath",
      "BlockMath",
      "FootnoteRef",
      "FootnoteDefinition",
      "Tag",
      "HTMLTag",
      "InlineComment",
      "CommentBlock",
    ]) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
  });

  it("does not treat prices as math", () => {
    const tree = plainMarkdownParser.parse("Costs $5 and $10 today.");
    expect(nodeNames(tree)).not.toContain("InlineMath");
  });

  it("parses an empty document and a document of blank lines", () => {
    expect(plainMarkdownParser.parse("").length).toBe(0);
    expect(nodeNames(plainMarkdownParser.parse("\n\n\n"))).toEqual(new Set(["Document"]));
  });

  // The fast parser reuses the tree before an edit. Whatever the edit, its result
  // must be identical to parsing the whole document from scratch.
  it("incremental parsing matches a full parse after random edits", () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const inserts = ["x", "\n", "```\n", "> ", "- ", "\n\n", "$$\n", "| a | b |\n", "# ", "---\n", "1. ", "%%\n", "[^1]: n\n"];
    let text = sample.repeat(12);
    let tree = notepadlyParser.parse(text);
    let fragments = TreeFragment.addTree(tree);
    for (let i = 0; i < 120; i++) {
      const from = next(text.length);
      const remove = next(4) === 0 ? Math.min(text.length - from, next(40)) : 0;
      const insert = next(3) === 0 ? "" : inserts[next(inserts.length)];
      text = text.slice(0, from) + insert + text.slice(from + remove);
      fragments = TreeFragment.applyChanges(fragments, [
        { fromA: from, toA: from + remove, fromB: from, toB: from + insert.length },
      ]);
      tree = notepadlyParser.parse(text, fragments);
      fragments = TreeFragment.addTree(tree, fragments);
      expect(tree.toString(), `edit ${i} at ${from}`).toBe(plainMarkdownParser.parse(text).toString());
    }
    // 240 full parses of a large document: slow under coverage instrumentation.
  }, 60_000);
});

/** Source text of every node with this name, in document order. */
function texts(source: string, name: string): string[] {
  const out: string[] = [];
  plainMarkdownParser.parse(source).iterate({
    enter: (node) => {
      if (node.name === name) out.push(source.slice(node.from, node.to));
    },
  });
  return out;
}

describe("markdown extensions: edge cases", () => {
  it("reads inline maths, but not escaped or spaced dollars", () => {
    expect(texts("a $x^2$ b", "InlineMath")).toEqual(["$x^2$"]);
    expect(texts("inline $$e=mc^2$$ here", "InlineMath")).toEqual(["$$e=mc^2$$"]);
    expect(texts("\\$x\\$ and $ y $", "InlineMath")).toEqual([]);
    expect(texts("$a \\$ b$", "InlineMath")).toEqual(["$a \\$ b$"]);
    expect(texts("$unclosed", "InlineMath")).toEqual([]);
  });

  it("reads multi-line and one-line block maths", () => {
    expect(texts("$$\na\nb\n$$\nafter", "BlockMath")).toEqual(["$$\na\nb\n$$"]);
    expect(texts("$$x$$", "BlockMath")).toEqual(["$$x$$"]);
  });

  // BUGS.md L12: block maths, comment blocks and footnotes worked at top level only.
  it("L12: reads block maths, comments and footnotes inside lists, quotes and callouts", () => {
    expect(texts("- $$\n  a\n  $$", "BlockMath")).toEqual(["$$\n  a\n  $$"]);
    expect(texts("> $$\n> a *b* c\n> $$\n\nafter", "BlockMath")).toEqual(["$$\n> a *b* c\n> $$"]);
    expect(texts("> [!note]\n> %%\n> hidden\n> %%", "CommentBlock")).toEqual(["%%\n> hidden\n> %%"]);
    expect(texts("> [^1]: a quoted note", "FootnoteDefinition")).toEqual(["[^1]: a quoted note"]);
    // Text inside the block is not Markdown.
    expect(texts("> $$\n> a *b* c\n> $$", "Emphasis")).toEqual([]);
  });

  it("L12: a block inside a quote ends with the quote", () => {
    expect(texts("> $$\n> a\n\noutside", "BlockMath")).toEqual(["$$\n> a"]);
    expect(texts("> %%\n> a\n\noutside *x*", "Emphasis")).toEqual(["*x*"]);
  });

  // BUGS.md L11: an unclosed $$ restyled up to 5,000 lines.
  it("L11: an unclosed $$ ends at the first blank line", () => {
    expect(texts("$$\na\n\n# Heading\n\ntext", "BlockMath")).toEqual(["$$\na"]);
    expect(texts("$$\na\n\n# Heading\n\ntext", "ATXHeading1")).toEqual(["# Heading"]);
  });

  // BUGS.md L11 (rest): an unclosed %% restyled up to 5,000 lines, unclosed front matter 1,000.
  it("L11: an unclosed %% ends at the first blank line; a closed one may hold blank lines", () => {
    expect(texts("%%\nhidden\n\n# Heading\n\ntext", "CommentBlock")).toEqual(["%%\nhidden"]);
    expect(texts("%%\nhidden\n\n# Heading\n\ntext", "ATXHeading1")).toEqual(["# Heading"]);
    expect(texts("%%\na\n\nb\n%%\nafter", "CommentBlock")).toEqual(["%%\na\n\nb\n%%"]);
    expect(texts("> %%\n> a\n>\n> b", "CommentBlock")).toEqual(["%%\n> a"]);
  });

  it("L11: front matter without a closing line is a rule and text", () => {
    const doc = "---\ntitle: x\nmore: y\n\n# Heading";
    expect(texts(doc, "Frontmatter")).toEqual([]);
    expect(texts(doc, "ATXHeading1")).toEqual(["# Heading"]);
    expect(texts("---\ntitle: x\n...\nbody", "Frontmatter")).toEqual(["---\ntitle: x\n..."]);
  });

  it("L11: adding or removing a far closer reparses the block that looked for it", () => {
    const filler = "para\n\n".repeat(30);
    const cases: [string, number, number, string][] = [];
    const comment = `intro\n\n%%\nhidden\n\n${filler}`;
    // Close the comment at the end, then open it again.
    cases.push([comment, comment.length, comment.length, "%%\n"]);
    const closed = `${comment}%%\n`;
    cases.push([closed, closed.length - 3, closed.length, ""]);
    const front = `---\ntitle: x\n\n${filler}`;
    cases.push([front, front.length, front.length, "---\n"]);
    cases.push([`${front}---\n`, front.length, front.length + 4, ""]);
    for (const [text, from, to, insert] of cases) {
      const tree = notepadlyParser.parse(text);
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
        { fromA: from, toA: to, fromB: from, toB: from + insert.length },
      ]);
      const next = text.slice(0, from) + insert + text.slice(to);
      expect(notepadlyParser.parse(next, fragments).toString(), JSON.stringify(insert)).toBe(
        plainMarkdownParser.parse(next).toString(),
      );
    }
  });

  // BUGS.md EDIT-9: a paragraph line starting with $$ turned the rest of the paragraph into maths.
  it("EDIT-9: a paragraph line that only starts with $$ stays text", () => {
    expect(texts("Cost:\n$$5 total\nmore text", "BlockMath")).toEqual([]);
    expect(texts("Cost:\n$$5 total\nmore text", "Paragraph")).toEqual(["Cost:\n$$5 total\nmore text"]);
    // A lone $$, or a line holding its closing $$, still starts display maths.
    expect(texts("text\n$$\nx\n$$", "BlockMath")).toEqual(["$$\nx\n$$"]);
    expect(texts("text\n$$  \nx\n$$", "BlockMath")).toEqual(["$$  \nx\n$$"]);
    expect(texts("text\n$$x$$\nmore", "BlockMath")).toEqual(["$$x$$"]);
  });

  it("does not let an unclosed $$ run past its line limit", () => {
    const doc = "$$\n" + "x\n".repeat(6000);
    const [math] = texts(doc, "BlockMath");
    expect(math.split("\n").length).toBeLessThanOrEqual(5002);
  });

  it("reads comments inline and as blocks", () => {
    expect(texts("a %%hidden%% b", "InlineComment")).toEqual(["%%hidden%%"]);
    expect(texts("%%\nblock\n%%", "CommentBlock")).toEqual(["%%\nblock\n%%"]);
    expect(texts("100%% sure", "InlineComment")).toEqual([]);
  });

  it("reads tags in any script but not numbers or mid-word hashes", () => {
    expect(texts("#todo #اردو #a/b-c #123 x#y (#paren)", "Tag")).toEqual(["#todo", "#اردو", "#a/b-c", "#paren"]);
    expect(texts("# Heading", "Tag")).toEqual([]);
  });

  it("reads wikilinks with aliases and embeds with sizes", () => {
    expect(texts("[[Page|Shown]]", "WikiAlias")).toEqual(["Shown"]);
    expect(texts("[[Page#Part]]", "WikiTarget")).toEqual(["Page#Part"]);
    expect(texts("![[img.png|200]]", "Embed")).toEqual(["![[img.png|200]]"]);
    expect(texts("[[]] and [[unclosed", "WikiLink")).toEqual([]);
  });

  it("reads highlights but not a lone or tripled equals", () => {
    expect(texts("==marked==", "Highlight")).toEqual(["==marked=="]);
    expect(texts("a === b", "Highlight")).toEqual([]);
    expect(texts("x = y", "Highlight")).toEqual([]);
  });

  it("reads footnote references and definitions", () => {
    const doc = "Text[^1] and[^note].\n\n[^1]: First\n[^note]: Second\n    continued";
    expect(texts(doc, "FootnoteRef")).toEqual(["[^1]", "[^note]"]);
    expect(texts(doc, "FootnoteDefinition")).toEqual(["[^1]: First", "[^note]: Second\n    continued"]);
    expect(texts("[^ spaced]", "FootnoteRef")).toEqual([]);
  });

  it("reads front matter only at the very start", () => {
    expect(texts("---\ntitle: x\n---\nbody", "Frontmatter")).toEqual(["---\ntitle: x\n---"]);
    expect(texts("intro\n\n---\ntitle: x\n---", "Frontmatter")).toEqual([]);
    // A rule followed by prose is not front matter.
    expect(texts("---\nJust prose here\n", "Frontmatter")).toEqual([]);
  });

  it("reads callout tags only at the start of a quote line", () => {
    expect(texts("> [!warning]- Careful", "CalloutTag")).toEqual(["[!warning]-"]);
    expect(texts("> text [!note]", "CalloutTag")).toEqual([]);
  });

  it("parses deeply nested lists and quotes without losing structure", () => {
    const doc = Array.from({ length: 12 }, (_v, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
    expect(texts(doc, "ListItem")).toHaveLength(12);
    expect(texts("> > > deep", "Blockquote")).toHaveLength(3);
  });

  it("never lets an unclosed opener on a very long line reach further than 4000 characters", () => {
    // An opener near the start, its closer far beyond the scan limit.
    const line = "$a " + "x ".repeat(5_000) + "b$ [[c " + "y ".repeat(5_000) + "]] %%d " + "z ".repeat(5_000) + "%%";
    const tree = plainMarkdownParser.parse(line);
    expect(tree.length).toBe(line.length);
    for (const name of ["InlineMath", "WikiLink", "InlineComment"]) expect(texts(line, name), name).toEqual([]);
    // Within the limit the same constructs are still found.
    expect(texts("$a " + "x ".repeat(100) + "b$", "InlineMath")).toHaveLength(1);
  });

  it("finds a closer up to exactly the scan limit", () => {
    expect(texts("[[" + "a".repeat(3999) + "]]", "WikiLink")).toHaveLength(1);
    expect(texts("[[" + "a".repeat(4000) + "]]", "WikiLink")).toEqual([]);
    expect(texts("[[a\n]]", "WikiLink")).toEqual([]);
    expect(texts("$" + "a".repeat(3998) + "$", "InlineMath")).toHaveLength(1);
    expect(texts("$" + "a".repeat(3999) + "$", "InlineMath")).toEqual([]);
  });

  it("EDIT-2: a long line full of unclosed openers parses about as fast as plain text", () => {
    const time = (text: string) => {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        plainMarkdownParser.parse(text);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const plain = time("abc ".repeat(4_900));
    // Each opener used to cut one string per character it scanned: about 50 times slower.
    for (const opener of ["[[a ", "![[a ", "[^a "]) {
      expect(time(opener.repeat(4_900)), opener).toBeLessThan(plain * 15 + 20);
    }
  });

  it("a long line full of unclosed dollars parses about as fast as plain text", () => {
    const time = (text: string) => {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        plainMarkdownParser.parse(text);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const plain = time("abc ".repeat(4_950));
    // Each dollar used to scan (and copy) the next 4,000 characters.
    for (const opener of ["$a ", "$$a "]) {
      expect(time(opener.repeat(19_800 / opener.length)), opener).toBeLessThan(plain * 4 + 10);
    }
  });

  it("finds the same maths after skipping a stretch already scanned", () => {
    // The second dollar resumes where the first one's scan stopped; its own window still counts.
    const gap = "x ".repeat(1_500);
    expect(texts(`$a ${gap}$b ${gap}c$ d`, "InlineMath")).toEqual([`$b ${gap}c$`]);
    expect(texts(`$a ${gap}$b ${gap}${gap}c$ d`, "InlineMath")).toEqual([]);
    expect(texts("$a \\$ b$ and $c$", "InlineMath")).toEqual(["$a \\$ b$", "$c$"]);
    expect(texts("$a b\n$c$ d", "InlineMath")).toEqual(["$c$"]);
    expect(texts("x $$a $ b$$ and $$c$$", "InlineMath")).toEqual(["$$a $ b$$", "$$c$$"]);
  });

  // BUGS.md L2 and L3: false tags and highlights.
  it("L2: colour codes are not tags", () => {
    expect(texts("color: #fff and #1a2b3c", "Tag")).toEqual([]);
    expect(texts("#FAFAFA #ccc #12345678", "Tag")).toEqual([]);
    // Words that happen to be hex stay tags.
    expect(texts("#cafe #bad #todo", "Tag")).toEqual(["#cafe", "#bad", "#todo"]);
  });
  it("L3: comparison operators are not highlight markers", () => {
    expect(texts("if a==b or c==d", "Highlight")).toEqual([]);
    expect(texts("a ==marked== b and x==y", "Highlight")).toEqual(["==marked=="]);
  });

  // BUGS.md L1: shell variables are not maths.
  it("L1: a dollar followed by a letter does not close maths", () => {
    expect(texts("Use $HOME/$USER for paths", "InlineMath")).toEqual([]);
    expect(texts("$x$, $y$ and $a+b$.", "InlineMath")).toEqual(["$x$", "$y$", "$a+b$"]);
  });
});

// BUGS.md H6 and the Lezer long-line cost: `[a](` repeated took 300-400 ms per 19,600-character line.
describe("overlong lines", () => {
  const long = "**b** [a](x) ".repeat(800); // 10,400 characters
  const short = "**b** [a](x) ".repeat(700); // 9,100 characters

  it("are not parsed for inline syntax, while shorter lines around them are", () => {
    expect(nodeNames(notepadlyParser.parse(long)).has("StrongEmphasis")).toBe(false);
    expect(nodeNames(notepadlyParser.parse(long)).has("Link")).toBe(false);
    expect(nodeNames(notepadlyParser.parse(short)).has("Link")).toBe(true);
    // The next line of the same paragraph is still parsed.
    const names = nodeNames(notepadlyParser.parse(`${long}\n**c**`));
    expect(names.has("StrongEmphasis")).toBe(true);
    expect(names.has("Link")).toBe(false);
  });

  it("parse `[a](` repeated over 40,000 characters quickly", () => {
    const start = performance.now();
    notepadlyParser.parse("[a](".repeat(10_000));
    expect(performance.now() - start).toBeLessThan(300);
  });
});
