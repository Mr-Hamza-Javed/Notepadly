// @vitest-environment jsdom
import "../../test/dom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { markdownSupport } from "../markdown";
import { blockField, blockPreview } from "./block";
import { isImagePath, parseSize, previewContext, resolveHref, resolveImageSrc, resolveWikiTarget } from "./context";
import { inlinePreview } from "./inline";
import { LruCache, renderMath } from "../lazy";
import { MermaidWidget } from "./widgets";

function preview(doc: string, cursor = doc.length): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdownSupport, history(), blockPreview, inlinePreview],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = new EditorView({ parent, state });
  // A no-op transaction lets the block field rescan with the full tree.
  view.dispatch({});
  return view;
}

/** The block widgets drawn, as [kind, first line of the replaced source]. */
function blocks(view: EditorView): [string, string][] {
  const out: [string, string][] = [];
  view.state.field(blockField).shown.between(0, view.state.doc.length, (from, to, deco) => {
    const widget = deco.spec.widget as { constructor: { name: string } } | undefined;
    const kind = widget ? widget.constructor.name.replace("Widget", "") : "Fold";
    out.push([kind, view.state.sliceDoc(from, to).split("\n")[0]]);
  });
  return out;
}

const lineText = (view: EditorView, n: number) =>
  (view.contentDOM.querySelectorAll(".cm-line")[n - 1] as HTMLElement | undefined)?.textContent ?? null;

describe("block widgets", () => {
  it("renders a table, a rule, block maths and a Mermaid diagram", () => {
    const doc = [
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "$$",
      "x^2",
      "$$",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "",
      "end",
    ].join("\n");
    expect(blocks(preview(doc))).toEqual([
      ["Table", "| a | b |"],
      ["HorizontalRule", "---"],
      ["Math", "$$"],
      ["Mermaid", "```mermaid"],
    ]);
  });

  it("renders a table that is the whole document, with no trailing newline", () => {
    const view = preview("| a |\n| - |\n| 1 |", 0);
    expect(blocks(view)).toEqual([["Table", "| a |"]]);
    const table = view.dom.querySelector("table")!;
    expect(Array.from(table.querySelectorAll("th,td")).map((c) => c.textContent)).toEqual(["a", "1"]);
  });

  it("renders a table at the very start and one at the very end", () => {
    const doc = "| s |\n| - |\n| 1 |\n\nmiddle\n\n| e |\n| - |\n| 2 |";
    expect(blocks(preview(doc, 15)).map(([kind]) => kind)).toEqual(["Table", "Table"]);
  });

  it("respects column alignment and renders inline markdown in cells", () => {
    const view = preview("| l | c | r |\n|:--|:-:|--:|\n| **b** | `x` | 3 |");
    const cells = Array.from(view.dom.querySelectorAll<HTMLElement>("th"));
    expect(cells.map((c) => c.style.textAlign)).toEqual(["left", "center", "right"]);
    expect(view.dom.querySelector("td strong")?.textContent).toBe("b");
    expect(view.dom.querySelector("td code")?.textContent).toBe("x");
  });

  it("keeps a table with a short row and an extra cell renderable", () => {
    const view = preview("| a | b |\n| - | - |\n| only |\n| 1 | 2 | 3 |");
    const rows = Array.from(view.dom.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.children).map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ["a", "b"],
      ["only", ""],
      ["1", "2"],
    ]);
  });

  it("does not render malformed blocks", () => {
    // Unclosed maths and an unclosed mermaid fence stay as text.
    expect(blocks(preview("$$\nx^2 without end"))).toEqual([]);
    expect(blocks(preview("```mermaid\ngraph TD; A-->B"))).toEqual([]);
    // A pipe line without a delimiter row is not a table.
    expect(blocks(preview("| a | b |\n| 1 | 2 |"))).toEqual([]);
  });

  it("leaves a rule inside a list or quote as source", () => {
    expect(blocks(preview("> ---\n\nx"))).toEqual([]);
  });

  // Text added past the scanned region is picked up by the viewport reporter a moment later.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("updates when a table is typed, edited and deleted", async () => {
    const view = preview("start\n");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n| h |\n| - |\n| v |" } });
    await tick();
    expect(blocks(view)).toEqual([["Table", "| h |"]]);
    view.dispatch({ changes: { from: 0, insert: "new first line\n" } });
    expect(blocks(view)).toEqual([["Table", "| h |"]]);
    const start = view.state.doc.toString().indexOf("| h |");
    view.dispatch({ changes: { from: start, to: view.state.doc.length } });
    expect(blocks(view)).toEqual([]);
    expect(view.dom.querySelector("table")).toBeNull();
  });

  it("does not leave a stale widget after the block's text is removed", async () => {
    const view = preview("text");
    view.dispatch({ changes: { from: 4, insert: "\n\n$$\na\n$$" }, userEvent: "input" });
    await tick();
    expect(blocks(view).map(([kind]) => kind)).toEqual(["Math"]);
    view.dispatch(view.state.update({ changes: { from: 4, to: view.state.doc.length } }));
    expect(blocks(view)).toEqual([]);
  });

  it("folds a callout marked with a minus until it is touched", () => {
    const doc = "> [!note]- Title\n> hidden body\n\nafter";
    const view = preview(doc);
    expect(blocks(view)).toEqual([["Fold", ""]]);
    view.dispatch({ selection: { anchor: doc.indexOf("hidden") } });
    expect(blocks(view)).toEqual([]);
  });

  it("does not fold an open callout", () => {
    expect(blocks(preview("> [!tip] Title\n> body\n\nafter"))).toEqual([]);
  });

  it("scans a long document lazily but still finds blocks near the top", () => {
    const filler = "paragraph line\n\n".repeat(5000);
    const view = preview(`| a |\n| - |\n| 1 |\n\n${filler}| z |\n| - |\n| 9 |`, 0);
    const kinds = blocks(view);
    expect(kinds[0]).toEqual(["Table", "| a |"]);
  });
});

describe("inline markers", () => {
  it("hides emphasis markers away from the cursor and shows them on it", () => {
    const view = preview("**bold** and *it*\n\nother line");
    expect(lineText(view, 1)).toBe("bold and it");
    view.dispatch({ selection: { anchor: 3 } });
    expect(lineText(view, 1)).toBe("**bold** and it");
  });

  it("hides heading markers until the line is touched", () => {
    const view = preview("## Heading\n\nbody");
    expect(lineText(view, 1)).toBe("Heading");
    expect(view.contentDOM.querySelector(".cm-line")?.className).toContain("cm-md-h2");
    view.dispatch({ selection: { anchor: 4 } });
    expect(lineText(view, 1)).toBe("## Heading");
  });

  it("shows link text only, and the full source when touched", () => {
    const view = preview("see [docs](https://x.y) now\n\nend");
    expect(lineText(view, 1)).toBe("see docs now");
    view.dispatch({ selection: { anchor: 6 } });
    expect(lineText(view, 1)).toBe("see [docs](https://x.y) now");
  });

  it("hides an escaping backslash", () => {
    const view = preview("a \\*literal\\* b\n\nend");
    expect(lineText(view, 1)).toBe("a *literal* b");
  });

  it("works on Urdu text and at the very start and end of the document", () => {
    const view = preview("**سلام**", 0);
    // The cursor at offset 0 touches the bold span, so its markers show.
    expect(lineText(view, 1)).toBe("**سلام**");
    const away = preview("**سلام**\nx");
    expect(lineText(away, 1)).toBe("سلام");
  });

  it("styles tags, comments and highlights", () => {
    const view = preview("#tag %%note%% ==hi==\n\nend");
    expect(view.contentDOM.querySelector(".cm-md-tag")?.textContent).toBe("#tag");
    expect(view.contentDOM.querySelector(".cm-md-comment")?.textContent).toBe("%%note%%");
    // The == markers are hidden while the cursor is elsewhere.
    expect(view.contentDOM.querySelector(".cm-md-highlight")?.textContent).toBe("hi");
  });

  it("renders task checkboxes and toggles them in the document", () => {
    const view = preview("- [ ] todo\n- [x] done\n\nend");
    const boxes = view.contentDOM.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(Array.from(boxes).map((b) => b.checked)).toEqual([false, true]);
    boxes[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    boxes[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(view.state.doc.line(1).text).toMatch(/^- \[[xX]\] todo$/);
  });
});

describe("maths and diagrams", () => {
  it("renders valid TeX with KaTeX", async () => {
    const out = await renderMath("x^2 + \\frac{1}{2}", true);
    expect(out.html).toContain("katex");
    expect(out.html).not.toContain("katex-error");
  });

  it("shows malformed TeX as an error instead of throwing", async () => {
    const out = await renderMath("\\frac{1}{", false);
    expect(out.html).toContain("katex-error");
  });

  it("never lets TeX run HTML", async () => {
    const out = await renderMath("\\href{javascript:alert(1)}{x} <img src=x onerror=alert(1)>", false);
    expect(out.html).not.toContain("javascript:");
    expect(out.html).not.toMatch(/<img/i);
  });

  it("caches renders by source and display mode", async () => {
    const a = await renderMath("y", true);
    expect(await renderMath("y", true)).toBe(a);
    expect(await renderMath("y", false)).not.toBe(a);
  });

  it("shows an error in place of a Mermaid diagram that cannot be rendered", async () => {
    const view = preview("text");
    const widget = new MermaidWidget("this is not a diagram %%%", false, 11);
    const dom = widget.toDOM(view);
    for (let i = 0; i < 200 && !dom.classList.contains("cm-md-render-error"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(dom.classList.contains("cm-md-render-error")).toBe(true);
    expect(dom.classList.contains("cm-md-pending")).toBe(false);
    expect(dom.textContent).not.toBe("");
    expect(dom.textContent).not.toBe("Rendering diagram…");
  }, 20_000);
});

describe("render cache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("replacing a key does not grow the cache", () => {
    const cache = new LruCache<number>(1);
    cache.set("a", 1);
    cache.set("a", 2);
    expect(cache.get("a")).toBe(2);
  });
});

describe("link and image targets", () => {
  it("adds https to www links and passes others through", () => {
    expect(resolveHref("www.example.com")).toBe("https://www.example.com");
    expect(resolveHref("WWW.x.y")).toBe("https://WWW.x.y");
    expect(resolveHref("notes/a.md")).toBe("notes/a.md");
  });

  it("drops the heading from wikilink targets", () => {
    expect(resolveWikiTarget(" Page #Section ")).toBe("wikilink:Page");
    expect(resolveWikiTarget("اردو صفحہ")).toBe("wikilink:اردو صفحہ");
  });

  it("resolves image paths against the document folder", () => {
    previewContext.baseDir = () => "C:\\notes\\";
    expect(resolveImageSrc("img/a%20b.png")).toBe("C:\\notes\\img\\a b.png");
    expect(resolveImageSrc("./x.png")).toBe("C:\\notes\\x.png");
    expect(resolveImageSrc("D:\\abs.png")).toBe("D:\\abs.png");
    expect(resolveImageSrc("https://x.y/i.png")).toBe("https://x.y/i.png");
    expect(resolveImageSrc("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
    // BUGS.md L14: http and file:// images.
    expect(resolveImageSrc("http://x.y/i.png")).toBe("http://x.y/i.png");
    expect(resolveImageSrc("file:///D:/pics/a%20b.png")).toBe("D:\\pics\\a b.png");
    previewContext.baseDir = () => null;
    // An untitled tab has no folder: a relative image is not read from the app's folder.
    expect(resolveImageSrc("rel.png")).toBe("");
  });

  it("keeps a malformed percent-encoding as written", () => {
    previewContext.baseDir = () => "C:\\n";
    expect(resolveImageSrc("100%.png")).toBe("C:\\n\\100%.png");
    previewContext.baseDir = () => null;
  });

  // BUGS.md SEC-2 / PREV-3: an image on another network host must not be fetched
  // when the document is shown (Windows would send the NTLM hash to that host).
  it("SEC-2: does not resolve an image on another network host", () => {
    previewContext.baseDir = () => "C:\\notes";
    for (const src of ["\\\\evil.example\\s\\x.png", "file://evil.example/s/x.png", "\\\\?\\UNC\\evil.example\\s\\x.png"]) {
      expect(resolveImageSrc(src), src).not.toMatch(/^\\\\/);
    }
    previewContext.baseDir = () => null;
  });

  it("recognises image files by extension", () => {
    for (const path of ["a.png", "b.JPG", "c.jpeg", "d.svg", "e.webp#frag", "f.avif "]) {
      expect(isImagePath(path), path).toBe(true);
    }
    for (const path of ["a.md", "b.pdf", "png", "c.png.txt"]) expect(isImagePath(path), path).toBe(false);
  });

  it("reads Obsidian size suffixes", () => {
    expect(parseSize("200")).toEqual({ width: 200, height: undefined });
    expect(parseSize(" 200x100 ")).toEqual({ width: 200, height: 100 });
    expect(parseSize("big")).toBeNull();
    expect(parseSize("200px")).toBeNull();
    expect(parseSize("")).toBeNull();
  });
});
