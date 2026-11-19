// @vitest-environment jsdom
// Editing rendered tables in place, and moving the cursor around rendered blocks.
import "../../test/dom";
import { cursorCharLeft, cursorCharRight, history, undoDepth } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { mountEngine } from "../../test/editorHarness";
import { engine } from "..";
import { applyFormat } from "../commands";
import { markdownSupport } from "../markdown";
import { splitRow } from "../tableModel";
import { blockField, blockPreview } from "./block";
import { inlinePreview } from "./inline";

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
  view.dispatch({});
  return view;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

/** Selects text in the focused cell, as the user would with the mouse. */
async function selectInCell(cell: HTMLElement, from: number, to: number): Promise<void> {
  const text = cell.firstChild!;
  getSelection()!.setBaseAndExtent(text, from, text, to);
  document.dispatchEvent(new Event("selectionchange"));
  await tick();
}

const KEY_CODES: Record<string, number> = { Tab: 9, Escape: 27, m: 77 };

function key(target: HTMLElement, init: KeyboardEventInit): void {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  // CodeMirror's tab focus mode reads keyCode, which jsdom leaves at 0.
  Object.defineProperty(event, "keyCode", { value: KEY_CODES[init.key ?? ""] ?? 0 });
  target.dispatchEvent(event);
}

/** Types into the focused cell the way the browser does: new text, then an input event. */
function typeInCell(cell: HTMLElement, text: string): void {
  cell.textContent = text;
  const node = cell.firstChild!;
  getSelection()!.setBaseAndExtent(node, text.length, node, text.length);
  cell.dispatchEvent(new Event("input", { bubbles: true }));
}

const fruit = "| fruit | n |\n| --- | --- |\n| apple | 2 |";

describe("a table cell mirrors its caret into the editor selection", () => {
  it("H1: Bold in a cell wraps the selected text, not the start of the cell", async () => {
    const view = preview(`${fruit}\n\nafter`);
    const cell = await focusCell(view.dom, "apple");
    await selectInCell(cell, 0, 5);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("apple");
    // The toolbar and the global Ctrl+B both run this command on the editor selection.
    applyFormat(view, { type: "bold" });
    expect(view.state.doc.line(3).text).toBe("| **apple** | 2 |");
    await tick();
    expect(cell.textContent).toBe("**apple**");
    // The cell's own Ctrl+I goes the same way.
    await selectInCell(cell, 2, 7);
    key(cell, { key: "i", ctrlKey: true });
    expect(view.state.doc.line(3).text).toBe("| ***apple*** | 2 |");
  });

  it("M1: Select All in a cell selects the cell's text only", async () => {
    mountEngine();
    engine.createDoc("t", `${fruit}\n\nafter`, "formatted");
    engine.activate("t");
    await tick();
    const cell = await focusCell(document, "apple");
    engine.selectAll();
    expect(engine.selectionText()).toBe("apple");
    expect(getSelection()!.toString()).toBe("apple");
    // Ctrl+A pressed in the cell itself does the same.
    await selectInCell(cell, 5, 5);
    key(cell, { key: "a", ctrlKey: true });
    expect(engine.selectionText()).toBe("apple");
  });

  it("M2: inserted text (F5, Paste, a link) goes to the caret in the cell, and cannot break the row", async () => {
    mountEngine();
    engine.createDoc("t", `${fruit}\n\nafter`, "formatted");
    engine.activate("t");
    await tick();
    const cell = await focusCell(document, "apple");
    await selectInCell(cell, 5, 5);
    engine.insertText(" pie");
    expect(engine.getText("t").split("\n")[2]).toBe("| apple pie | 2 |");
    await tick();
    expect(cell.textContent).toBe("apple pie");
    expect(getSelection()!.anchorOffset).toBe(9);
    engine.insertText("a|b\nc");
    expect(engine.getText("t").split("\n")[2]).toBe("| apple piea\\|b c | 2 |");
  });

  it("typing keeps the editor selection on the caret, with escaped pipes", async () => {
    const view = preview(`${fruit}\n\nafter`);
    const cell = await focusCell(view.dom, "apple");
    typeInCell(cell, "a|b");
    expect(view.state.doc.line(3).text).toBe("| a\\|b | 2 |");
    expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from + "| a\\|b".length);
  });

  it("L9: a backslash typed at the end of an unpadded cell does not merge it with the next", async () => {
    const view = preview("|a|b|\n|-|-|\n|c|d|\n\nafter");
    const cell = await focusCell(view.dom, "c");
    typeInCell(cell, "c\\");
    const row = view.state.doc.line(3).text;
    expect(splitRow(row).map((span) => row.slice(span.from, span.to))).toEqual(["c\\", "d"]);
  });
});

describe("leaving a table from the keyboard", () => {
  it("H3: Up in the header of a table at the top of the document stays in the table", async () => {
    const view = preview(`${fruit}\n\nafter`);
    const cell = await focusCell(view.dom, "fruit");
    key(cell, { key: "ArrowUp" });
    await tick();
    expect(document.activeElement).toBe(cell);
    typeInCell(cell, "fruits");
    expect(view.state.doc.toString()).toBe(`${fruit.replace("fruit ", "fruits ")}\n\nafter`);
  });

  it("M5: Down in the last row of a table at the end does not change the document; Escape keeps it clean", async () => {
    const { log } = mountEngine();
    engine.createDoc("t", `before\n\n${fruit}`, "formatted");
    engine.activate("t");
    await tick();
    const cell = await focusCell(document, "apple");
    key(cell, { key: "ArrowDown" });
    expect(engine.getText("t")).toBe(`before\n\n${fruit}`);
    expect(document.activeElement).toBe(cell);
    key(cell, { key: "Escape" });
    // A line to land on is added, but it is not an edit: no undo step, no unsaved dot.
    expect(engine.getText("t")).toBe(`before\n\n${fruit}\n`);
    expect(log.dirty.filter(([, dirty]) => dirty)).toEqual([]);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    expect(undoDepth(view.state)).toBe(0);
  });

  it("Down in the last row moves below a table that has text after it", async () => {
    const view = preview(`${fruit}\n\nafter`);
    const cell = await focusCell(view.dom, "apple");
    key(cell, { key: "ArrowDown" });
    expect(view.state.selection.main.head).toBe(fruit.length + 1);
  });
});

describe("moving the cursor across rendered blocks", () => {
  it("H2: Left and Right cross a table, maths and a diagram in one step each", () => {
    const doc = ["top", fruit, "", "$$", "x^2", "$$", "", "```mermaid", "graph TD; A-->B", "```", "end"].join("\n");
    const view = preview(doc);
    const edges: number[] = [];
    view.state.field(blockField).shown.between(0, doc.length, (from, to) => {
      edges.push(from, to);
    });
    expect(edges.length).toBe(6);
    let presses = 0;
    while (view.state.selection.main.head > 0 && presses < 100) {
      cursorCharLeft(view);
      presses++;
    }
    // Without atomic blocks this took one press per hidden character (over 80 here).
    expect(presses).toBeLessThan(20);
    presses = 0;
    while (view.state.selection.main.head < doc.length && presses < 100) {
      cursorCharRight(view);
      const head = view.state.selection.main.head;
      // The cursor may sit on a block's edge, never inside it.
      for (let i = 0; i < edges.length; i += 2) expect(head <= edges[i] || head >= edges[i + 1]).toBe(true);
      presses++;
    }
    expect(presses).toBeLessThan(20);
  });

  it("an arrow key that lands on a table's edge enters the table", async () => {
    mountEngine();
    engine.createDoc("t", `top\n${fruit}\n\nafter`, "formatted");
    engine.activate("t");
    await tick();
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>(".cm-md-table th, .cm-md-table td"))) {
      cell.tabIndex = 0;
    }
    view.contentDOM.tabIndex = 0;
    view.focus();
    view.dispatch({ selection: { anchor: 3 } });
    await tick();
    cursorCharRight(view);
    await tick();
    expect((document.activeElement as HTMLElement).textContent).toBe("fruit");
    expect(getSelection()!.anchorOffset).toBe(0);

    // From the line below, Left enters the last cell at its end.
    view.focus();
    view.dispatch({ selection: { anchor: 4 + fruit.length + 1 } });
    await tick();
    cursorCharLeft(view);
    await tick();
    expect((document.activeElement as HTMLElement).textContent).toBe("2");
  });
});

describe("Find inside rendered blocks", () => {
  it("H11: a Find match in a table cell is shown in the cell", async () => {
    const view = preview(`${fruit}\n\nafter`, 0);
    const at = fruit.indexOf("pple");
    view.dispatch({ selection: { anchor: at, head: at + 4 }, userEvent: "select.search" });
    await tick();
    const mark = view.dom.querySelector(".cm-md-table mark.cm-md-cell-selection");
    expect(mark?.textContent).toBe("pple");
    expect(mark?.parentElement?.textContent).toBe("apple");
    // Moving on removes the mark and renders the cell again.
    view.dispatch({ selection: { anchor: view.state.doc.length }, userEvent: "select.search" });
    await tick();
    expect(view.dom.querySelector(".cm-md-cell-selection")).toBeNull();
  });

  it("H11: a Find match in block maths opens its source", () => {
    const doc = "text\n\n$$\npear^2\n$$\n\nend";
    const view = preview(doc, 0);
    expect(view.state.field(blockField).shown.size).toBe(1);
    const at = doc.indexOf("pear");
    view.dispatch({ selection: { anchor: at, head: at + 4 }, userEvent: "select.search" });
    expect(view.state.field(blockField).shown.size).toBe(0);
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.state.field(blockField).shown.size).toBe(1);
  });
});

describe("engine keys", () => {
  it("M3: Ctrl+M does not switch Tab to moving focus out of the editor", () => {
    mountEngine();
    engine.createDoc("t", "text", "formatted");
    engine.activate("t");
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ selection: { anchor: 0 } });
    key(content, { key: "m", ctrlKey: true });
    key(content, { key: "Tab" });
    expect(engine.getText("t")).toBe("\ttext");
  });
});

describe("IME composition in a table cell", () => {
  /** What an IME does: edits the cell's own text node in place, firing composition and input events. */
  function compose(cell: HTMLElement, steps: string[], final: string): Text {
    const node = cell.firstChild as Text;
    const base = node.data;
    cell.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    for (const step of steps) {
      node.data = base + step;
      getSelection()!.setBaseAndExtent(node, node.data.length, node, node.data.length);
      cell.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: step }));
      cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: step, isComposing: true }));
    }
    node.data = base + final;
    getSelection()!.setBaseAndExtent(node, node.data.length, node, node.data.length);
    cell.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: final }));
    cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: final }));
    return node;
  }

  it("keeps the cell's text node through the composition and writes the committed text once", async () => {
    const view = preview(fruit + "\n\nend", 0);
    const cell = await focusCell(view.dom, "apple");
    const node = cell.firstChild as Text;
    const kept = compose(cell, ["n", "ni", "nih"], "你好");
    await tick();
    // The DOM the IME is working in was never replaced, so the composition is not broken.
    expect(cell.firstChild).toBe(node);
    expect(kept.data).toBe("apple你好");
    expect(view.state.doc.line(3).text).toBe("| apple你好 | 2 |");
    expect(cell.classList.contains("is-editing")).toBe(true);
    // The caret stays at the end of the committed text, in the cell and in the editor.
    const from = view.state.doc.line(3).from + 2;
    expect(view.state.selection.main.head).toBe(from + "apple你好".length);
    // The pinyin typed on the way is not left behind as separate undo steps.
    expect(undoDepth(view.state)).toBe(1);
  });

  it("an editor update while composing leaves the composed text in the cell alone", async () => {
    const view = preview(fruit + "\n\nend", 0);
    const cell = await focusCell(view.dom, "apple");
    const node = cell.firstChild as Text;
    cell.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    node.data = "appleか";
    cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "か", isComposing: true }));
    // Something else changes the table's text (an edit through the editor, a reload).
    view.dispatch({ changes: { from: view.state.doc.line(3).to - 2, insert: "0" } });
    await tick();
    expect(cell.firstChild).toBe(node);
    expect(node.data).toBe("appleか");
    node.data = "apple蚊";
    cell.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "蚊" }));
    await tick();
    expect(view.state.doc.line(3).text).toBe("| apple蚊 | 20 |");
  });

  it("an Urdu composition in an empty cell fills the cell", async () => {
    const view = preview("| a | b |\n| - | - |\n| x |  |\n\nend", 0);
    const cell = await focusCell(view.dom, "x");
    compose(cell, ["ا", "اس"], "اسلام");
    await tick();
    expect(view.state.doc.line(3).text).toBe("| xاسلام |  |");
  });
});
