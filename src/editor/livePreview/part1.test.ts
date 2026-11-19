// @vitest-environment jsdom
// Live preview and table fixes from BUGS.md Part 1 (TAB-*, PREV-6 to PREV-10, MD-1, H2).
import "../../test/dom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { markdownSupport } from "../markdown";
import { blockField, blockPreview, verticalIntoBlock } from "./block";
import { cursorCharLeft, cursorCharRight } from "@codemirror/commands";
import { inlinePreview } from "./inline";
import { previewContext, resolveImageSrc } from "./context";
import { classifyHref } from "../../state/logic";
import { HorizontalRuleWidget, MathWidget, MermaidWidget, TableWidget, renderCellHtml } from "./widgets";
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

describe("blocks inside lists, quotes and callouts", () => {
  function widgets(view: EditorView): WidgetType[] {
    const out: WidgetType[] = [];
    view.state.field(blockField).shown.between(0, view.state.doc.length, (_f, _t, deco) => {
      if (deco.spec.widget) out.push(deco.spec.widget as WidgetType);
    });
    return out;
  }

  it("MD-1: a maths block in a list item is rendered, indented like the item", () => {
    const view = preview("- item\n\n  $$\n  x^2\n  $$\n\nend", 0);
    const [math] = widgets(view);
    expect(math).toBeInstanceOf(MathWidget);
    expect((math as MathWidget).source).toBe("x^2");
    expect((math as MathWidget).nest.indent).toBe(2);
    const host = view.dom.querySelector<HTMLElement>(".cm-md-math-block")!;
    expect(host.style.marginInlineStart).toBe("2ch");
  });

  it("MD-1: a maths block in a quote is rendered without the quote markers, with the quote bar", () => {
    const view = preview("> $$\n> a +\n> b\n> $$\n\nend", 0);
    const [math] = widgets(view) as MathWidget[];
    expect(math).toBeInstanceOf(MathWidget);
    expect(math.source).toBe("a +\nb");
    const host = view.dom.querySelector<HTMLElement>(".cm-md-math-block")!;
    expect(host.classList.contains("cm-md-q1")).toBe(true);
  });

  it("MD-1: a Mermaid diagram in a callout is rendered with the callout's colours", () => {
    const view = preview("> [!tip]\n> ```mermaid\n> graph TD; A-->B\n> ```\n\nend", 0);
    const [diagram] = widgets(view) as MermaidWidget[];
    expect(diagram).toBeInstanceOf(MermaidWidget);
    expect(diagram.source).toBe("graph TD; A-->B");
    expect(diagram.nest.classes).toContain("cm-md-callout-tip");
  });

  it("MD-1: a table and a rule in a quote are rendered", () => {
    const view = preview("> | a | b |\n> | - | - |\n> | c | d |\n>\n> ---\n\nend", 0);
    const kinds = widgets(view).map((w) => w.constructor);
    expect(kinds).toEqual([TableWidget, HorizontalRuleWidget]);
    const cells = Array.from(view.dom.querySelectorAll(".cm-md-table td")).map((td) => td.textContent);
    expect(cells).toEqual(["c", "d"]);
  });

  it("MD-1: a block on a list marker's line and blocks in a folded callout stay source", () => {
    expect(widgets(preview("- $$\n  x\n  $$\n\nend", 0))).toEqual([]);
    const folded = widgets(preview("> [!note]-\n> $$\n> x\n> $$\n\nend", 0));
    expect(folded.some((w) => w instanceof MathWidget)).toBe(false);
  });

  it("MD-1: typing in a table inside a quote keeps the quote markers", async () => {
    const view = preview("> | a | b |\n> | - | - |\n> | c | d |\n\nend", 0);
    const cell = await focusCell(view.dom, "c");
    typeInCell(cell, "cc");
    await tick();
    expect(view.state.doc.line(3).text).toBe("> | cc | d |");
  });
});

describe("entering maths and diagrams from the keyboard", () => {
  async function focusedEngineView(text: string): Promise<EditorView> {
    mountEngine();
    engine.createDoc("t", text, "formatted");
    engine.activate("t");
    await tick();
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    view.contentDOM.tabIndex = 0;
    view.focus();
    return view;
  }

  it("H2: Right from the line above a maths block opens it with the cursor on the formula", async () => {
    const text = "top\n$$\nx^2\n$$\nend";
    const view = await focusedEngineView(text);
    view.dispatch({ selection: { anchor: 3 } });
    await tick();
    cursorCharRight(view);
    await tick();
    expect(view.state.field(blockField).editing).toBe(4);
    expect(view.state.selection.main.head).toBe(text.indexOf("x^2"));
    expect(view.dom.querySelector(".cm-md-math-block")).toBeNull();
    engine.destroy();
  });

  it("H2: Left from the line below a diagram opens it with the cursor at the end of its code", async () => {
    const text = "top\n```mermaid\ngraph TD; A-->B\n```\nend";
    const view = await focusedEngineView(text);
    view.dispatch({ selection: { anchor: text.indexOf("end") } });
    await tick();
    cursorCharLeft(view);
    await tick();
    expect(view.state.field(blockField).editing).toBe(4);
    expect(view.state.selection.main.head).toBe(text.indexOf("B\n```") + 1);
    engine.destroy();
  });

  it("H2: Left from the line below a maths block lands at the end of the formula", async () => {
    const text = "top\n$$\nx^2\n$$\nend";
    const view = await focusedEngineView(text);
    view.dispatch({ selection: { anchor: text.indexOf("end") } });
    await tick();
    cursorCharLeft(view);
    await tick();
    expect(view.state.selection.main.head).toBe(text.indexOf("x^2") + 3);
    engine.destroy();
  });

  // With real layout CodeMirror's Up/Down jump over a block widget to the line past it, so the
  // edge that enters the block was never reached (found by the e2e tests in e2e/navigation).
  it("H2: Down from the line above a maths block opens it on the formula", async () => {
    const text = "top\n$$\nx^2\n$$\nend";
    const view = await focusedEngineView(text);
    view.dispatch({ selection: { anchor: 1 } });
    await tick();
    expect(verticalIntoBlock(view, true)).toBe(true);
    await tick();
    expect(view.state.field(blockField).editing).toBe(4);
    expect(view.state.selection.main.head).toBe(text.indexOf("x^2"));
    engine.destroy();
  });

  it("H2: Up from the line below a table stops on its edge; other lines move as usual", async () => {
    const table = "| a | b |\n| - | - |\n| x | y |";
    const text = `top\n${table}\n\nend`;
    const view = await focusedEngineView(text);
    const below = text.indexOf("\n\nend") + 1;
    view.dispatch({ selection: { anchor: below } });
    expect(verticalIntoBlock(view, false)).toBe(true);
    expect(view.state.selection.main.head).toBe(4 + table.length);
    view.dispatch({ selection: { anchor: text.indexOf("end") } });
    expect(verticalIntoBlock(view, false)).toBe(false);
    engine.destroy();
  });

  it("typing on the empty last line right under a table carries on in the new row's cell", async () => {
    // jsdom only focuses cells with a tabindex; give every cell one as it is made.
    const observer = new MutationObserver(() => {
      for (const cell of document.querySelectorAll<HTMLElement>(".cm-md-table th, .cm-md-table td")) cell.tabIndex = 0;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const text = "| a | b |\n| - | - |\n| x | y |\n";
    const view = await focusedEngineView(text);
    view.dispatch({ selection: { anchor: text.length } });
    await tick();
    // In GFM the typed line is now a table row: the cursor sits at the hidden end of the table.
    view.dispatch({ changes: { from: text.length, insert: "n" }, selection: { anchor: text.length + 1 }, userEvent: "input.type" });
    await tick();
    await tick();
    const active = document.activeElement as HTMLElement;
    expect(active.closest(".cm-md-table")).not.toBeNull();
    expect(active.dataset.row).toBe("3");
    expect(active.textContent).toBe("n");
    observer.disconnect();
    engine.destroy();
  });
});

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
    expect(engine.getText("t1")).toBe(`${text}\n\n`);
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
