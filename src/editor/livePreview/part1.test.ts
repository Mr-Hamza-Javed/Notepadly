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
import { previewContext } from "./context";
import { renderCellHtml } from "./widgets";

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
