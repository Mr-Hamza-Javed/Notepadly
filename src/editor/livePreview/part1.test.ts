// @vitest-environment jsdom
// Live preview and table fixes from BUGS.md Part 1 (TAB-*, PREV-6 to PREV-10, MD-1, H2).
import "../../test/dom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { markdownSupport } from "../markdown";
import { blockPreview } from "./block";
import { inlinePreview } from "./inline";
import { previewContext, resolveImageSrc } from "./context";
import { classifyHref } from "../../state/logic";
import { renderCellHtml } from "./widgets";
import { mountEngine } from "../../test/editorHarness";
import { engine } from "..";

const extensions = [markdownSupport, history(), blockPreview, inlinePreview];

export function preview(doc: string, cursor = doc.length, extra: unknown[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [extensions, extra as never] });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = new EditorView({ parent, state });
  view.dispatch({});
  return view;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function cellNode(html: string): HTMLElement {
  const td = document.createElement("td");
  td.innerHTML = html;
  return td;
}

afterEach(() => {
  previewContext.baseDir = () => null;
  document.body.replaceChildren();
});

describe("image and link paths", () => {
  it("PREV-8: a leading-slash image and link both start at the drive or share root", () => {
    previewContext.baseDir = () => "C:\\docs\\sub";
    expect(resolveImageSrc("/img/a.png")).toBe("C:\\img\\a.png");
    expect(classifyHref("/img/a.md", "C:\\docs\\sub")).toEqual({ kind: "file", path: "C:\\img\\a.md" });
    previewContext.baseDir = () => "\\\\nas\\docs\\sub";
    expect(resolveImageSrc("/img/a.png")).toBe("\\\\nas\\docs\\img\\a.png");
    expect(classifyHref("/img/a.md", "\\\\nas\\docs\\sub")).toEqual({ kind: "file", path: "\\\\nas\\docs\\img\\a.md" });
  });

  it("PREV-8: `..` in an image path is resolved like in a link", () => {
    previewContext.baseDir = () => "C:\\docs\\sub";
    expect(resolveImageSrc("../img/a.png")).toBe("C:\\docs\\img\\a.png");
    expect(resolveImageSrc("./a%20b.png")).toBe("C:\\docs\\sub\\a b.png");
  });

  it("an untitled tab loads no relative image (it would be read from the app's folder)", () => {
    previewContext.baseDir = () => null;
    expect(resolveImageSrc("pic.png")).toBe("");
    expect(resolveImageSrc("/pic.png")).toBe("");
    expect(resolveImageSrc("D:\\pics\\a.png")).toBe("D:\\pics\\a.png");
    expect(resolveImageSrc("https://x.y/a.png")).toBe("https://x.y/a.png");
  });
});

describe("table cell rendering", () => {
  it("TAB-3: emphasis markers inside a link target are left as written", () => {
    const a = cellNode(renderCellHtml("[x](https://a.b/_c_/d)")).querySelector("a")!;
    expect(a.dataset.href).toBe("https://a.b/_c_/d");
    expect(a.textContent).toBe("x");
    const b = cellNode(renderCellHtml("[x](https://a.b/*c*) and *em*")).querySelector("a")!;
    expect(b.dataset.href).toBe("https://a.b/*c*");
    expect(renderCellHtml("[x](https://a.b/*c*) and *em*")).toContain("<em>em</em>");
  });

  it("TAB-3: emphasis still works in the link text", () => {
    const a = cellNode(renderCellHtml("[**bold** text](https://x.y)")).querySelector("a")!;
    expect(a.innerHTML).toBe("<strong>bold</strong> text");
  });

  it("PREV-10: a link whose URL has balanced parentheses keeps the whole URL", () => {
    const td = cellNode(renderCellHtml("[w](https://en.wikipedia.org/wiki/Foo_(bar))"));
    expect(td.querySelector("a")!.dataset.href).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(td.textContent).toBe("w");
  });

  it("TAB-2: inline maths in a cell becomes a maths placeholder, not text", () => {
    const td = cellNode(renderCellHtml("area $a^2$ and $$b_1$$, costs $5 and $6"));
    const maths = Array.from(td.querySelectorAll<HTMLElement>("[data-math]")).map((m) => m.dataset.math);
    expect(maths).toEqual(["a^2", "b_1"]);
    expect(td.textContent).toContain("costs $5 and $6");
  });

  it("TAB-2: emphasis rules do not run inside maths", () => {
    const td = cellNode(renderCellHtml("$a_1 + b_2$"));
    expect(td.querySelector("em")).toBeNull();
    expect(td.querySelector<HTMLElement>("[data-math]")!.dataset.math).toBe("a_1 + b_2");
  });

  it("TAB-2: wikilinks in a cell become links that open the note", () => {
    const td = cellNode(renderCellHtml("see [[My Note#Part|the note]] or [[Other]]"));
    const links = Array.from(td.querySelectorAll<HTMLElement>("a"));
    expect(links.map((a) => [a.dataset.href, a.textContent])).toEqual([
      ["wikilink:My Note", "the note"],
      ["wikilink:Other", "Other"],
    ]);
  });

  it("TAB-2: images in a cell go through the safe resolver", () => {
    previewContext.baseDir = () => "C:\\notes";
    const td = cellNode(renderCellHtml("![a pic|40](img/a.png) ![[b.png|20x10]] ![](\\\\evil\\s\\x.png)"));
    const images = Array.from(td.querySelectorAll("img"));
    expect(images.map((img) => img.getAttribute("src"))).toEqual(["C:\\notes\\img\\a.png", "C:\\notes\\b.png", null]);
    expect(images[0].alt).toBe("a pic");
    expect(images[0].getAttribute("width")).toBe("40");
    expect(images[1].getAttribute("height")).toBe("10");
  });

  it("TAB-2: a cell's maths is rendered by KaTeX in a live table", async () => {
    const view = preview("| a | b |\n| - | - |\n| $x^2$ | y |\n\nafter", 0);
    const host = view.dom.querySelector<HTMLElement>(".cm-md-table [data-math]")!;
    expect(host).not.toBeNull();
    for (let i = 0; i < 50 && !host.querySelector(".katex"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(host.querySelector(".katex")).not.toBeNull();
    await tick();
  });
});

describe("relative images after the document moves", () => {
  it("PREV-7: a save to a new folder re-resolves images in text and in table cells", async () => {
    let dir: string | null = null;
    const { parent } = mountEngine({ baseDir: () => dir });
    engine.createDoc("t1", "intro\n\n![p](pic.png)\n\n| a |\n| - |\n| ![q](q.png) |\n\nend", "formatted");
    engine.activate("t1");
    await tick();
    await tick();
    const sources = () => Array.from(parent.querySelectorAll("img.cm-md-image")).map((img) => img.getAttribute("src"));
    expect(sources()).toEqual([null, null]);
    // First save of the untitled tab.
    dir = "C:\\notes";
    engine.pathChanged("t1");
    await tick();
    expect(sources()).toEqual(["C:\\notes\\pic.png", "C:\\notes\\q.png"]);
    // Save As to another folder.
    dir = "D:\\other";
    engine.pathChanged("t1");
    await tick();
    expect(sources()).toEqual(["D:\\other\\pic.png", "D:\\other\\q.png"]);
    engine.destroy();
  });
});

/** jsdom cannot focus a contenteditable cell; a tabIndex makes it focusable as in a browser. */
async function focusCell(root: ParentNode, text: string): Promise<HTMLElement> {
  const cell = Array.from(root.querySelectorAll<HTMLElement>(".cm-md-table th, .cm-md-table td")).find(
    (c) => c.textContent === text,
  );
  if (!cell) throw new Error(`no cell ${text}`);
  cell.tabIndex = 0;
  cell.focus();
  await tick();
  return cell;
}

/** Types into the focused cell the way the browser does: new text, then an input event. */
function typeInCell(cell: HTMLElement, text: string): void {
  cell.textContent = text;
  const node = cell.firstChild!;
  getSelection()!.setBaseAndExtent(node, text.length, node, text.length);
  cell.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(target: Element | null, init: KeyboardEventInit): void {
  target!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("Find matches in table cells", () => {
  it("TAB-1: every match in the table's cells is marked, not only the current one", async () => {
    const { parent } = mountEngine();
    engine.createDoc("t1", "apple\n\n| fruit | note |\n| - | - |\n| apple | an apple a day |\n| pear | **apple** |\n\nend", "formatted");
    engine.activate("t1");
    await tick();
    await tick();
    const result = engine.find({ search: "apple", replace: "", caseSensitive: false, wrap: true });
    expect(result.total).toBe(4);
    await tick();
    const table = parent.querySelector(".cm-md-table")!;
    const marks = () =>
      Array.from(table.querySelectorAll("mark")).map((m) => [m.className, m.textContent, m.closest("td")!.dataset.row]);
    expect(marks()).toEqual([
      ["cm-find-match", "apple", "2"],
      ["cm-find-match", "apple", "2"],
      ["cm-find-match", "apple", "3"],
    ]);
    // The next match is in the table: it becomes the strong mark, the others stay marked.
    engine.findNext();
    await tick();
    expect(marks()).toEqual([
      ["cm-md-cell-selection", "apple", "2"],
      ["cm-find-match", "apple", "2"],
      ["cm-find-match", "apple", "3"],
    ]);
    // Closing Find shows the cells rendered again.
    engine.clearFind();
    engine.goToLine(1);
    await tick();
    expect(marks()).toEqual([]);
    expect(table.querySelector("td[data-row='3'][data-col='1'] strong")?.textContent).toBe("apple");
    engine.destroy();
  });
});

describe("right-to-left text in table cells", () => {
  it("cells take their direction from their text, so Urdu aligns right", () => {
    const view = preview("| نام | n |\n| - | -: |\n| علی | 2 |\n\nafter", 0);
    const cells = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-md-table th, .cm-md-table td"));
    expect(cells.every((cell) => cell.dir === "auto")).toBe(true);
    // An explicit alignment from the delimiter row still applies.
    expect(cells[1].style.textAlign).toBe("right");
    expect(cells[0].style.textAlign).toBe("");
  });
});

describe("leaving a table at the end of a partly loaded file", () => {
  it("TAB-4: Escape in the last row adds no newline while the file is still loading", async () => {
    let loaded = false;
    const { parent } = mountEngine({ isFullyLoaded: () => loaded });
    const text = "intro\n\n| a |\n| - |\n| x |";
    engine.createDoc("t1", text, "formatted");
    engine.activate("t1");
    await tick();
    await tick();
    const cell = await focusCell(parent, "x");
    key(cell, { key: "Escape" });
    await tick();
    expect(engine.getText("t1")).toBe(text);
    expect(document.activeElement).toBe(cell);
    // Once the whole file is there, Escape adds the line to land on as before.
    loaded = true;
    key(cell, { key: "Escape" });
    await tick();
    expect(engine.getText("t1")).toBe(`${text}\n`);
    engine.destroy();
  });
});

describe("typing in a table without outer pipes", () => {
  for (const marker of ["- ", "# ", "> ", "1. ", "+ "]) {
    it(`PREV-6: typing "${marker}" at the start of a first cell keeps the table whole`, async () => {
      const view = preview("a | b\n--|--\nc | d\ne | f\n\nafter", 0);
      const cell = await focusCell(view.dom, "e");
      typeInCell(cell, `${marker}e`);
      await tick();
      const table = view.dom.querySelector(".cm-md-table")!;
      expect(table.querySelectorAll("tr").length).toBe(3);
      expect(cell.isConnected).toBe(true);
      expect(document.activeElement).toBe(cell);
      const cells = Array.from(table.querySelectorAll("tr:last-child td")).map((td) => td.textContent);
      expect(cells[1]).toBe("f");
      expect(view.state.doc.line(4).text).toBe(`| ${marker}e | f |`);
      // The text shows as typed while the cell is edited.
      expect(cell.textContent).toBe(`${marker}e`);
    });
  }
});
