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
  });
});
