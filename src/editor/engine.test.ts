// @vitest-environment jsdom
import { mountEngine, nextFrame } from "../test/editorHarness";
import { beforeEach, describe, expect, it } from "vitest";
import { engine } from ".";

const lastDirty = (log: ReturnType<typeof mountEngine>["log"], id: string) =>
  [...log.dirty].reverse().find(([tab]) => tab === id)?.[1] ?? false;

describe("editor engine: documents and tabs", () => {
  beforeEach(() => {
    mountEngine();
  });

  it("keeps one independent document per tab", () => {
    engine.createDoc("a", "alpha", "plain");
    engine.createDoc("b", "beta", "plain");
    engine.activate("a");
    engine.insertText("1");
    engine.activate("b");
    engine.insertText("2");
    expect(engine.getText("a")).toBe("1alpha");
    expect(engine.getText("b")).toBe("2beta");
  });

  it("reports length and first line without needing the tab to be active", () => {
    engine.createDoc("a", "first line\nsecond", "plain");
    expect(engine.length("a")).toBe(17);
    expect(engine.firstLine?.("a")).toBe("first line");
    expect(engine.getText("missing")).toBe("");
    expect(engine.length("missing")).toBe(0);
  });

  it("forgets a dropped document, including the active one", () => {
    engine.createDoc("a", "text", "plain");
    engine.activate("a");
    engine.dropDoc("a");
    expect(engine.hasDoc("a")).toBe(false);
    expect(engine.getText("a")).toBe("");
    // Editing commands now go to an inert placeholder, never to the dropped tab.
    engine.insertText("x");
    expect(engine.hasDoc("a")).toBe(false);
  });

  it("restores the selection of each tab when switching back", () => {
    engine.createDoc("a", "hello world", "plain");
    engine.createDoc("b", "other", "plain");
    engine.activate("a");
    engine.restore("a", { anchor: 6, head: 11, scrollTop: 0 });
    engine.activate("b");
    engine.activate("a");
    expect(engine.selectionText()).toBe("world");
    expect(engine.snapshot("a")).toMatchObject({ anchor: 6, head: 11 });
  });

  it("clamps a restored position that lies past the end of the document", () => {
    engine.createDoc("a", "short", "plain");
    engine.restore("a", { anchor: 999, head: 1000, scrollTop: 5 });
    expect(engine.snapshot("a")).toMatchObject({ anchor: 5, head: 5 });
  });

  it("keeps Urdu, emoji and CRLF-free text exactly as given", () => {
    const text = "سلام دنیا 😀\nدوسری لائن";
    engine.createDoc("a", text, "formatted");
    engine.activate("a");
    expect(engine.getText("a")).toBe(text);
    expect(engine.lineCount()).toBe(2);
  });
});

describe("editor engine: dirty state follows the undo history", () => {
  let log: ReturnType<typeof mountEngine>["log"];
  beforeEach(() => {
    ({ log } = mountEngine());
    engine.createDoc("a", "saved text", "plain");
    engine.activate("a");
  });

  it("marks a tab dirty on the first edit and reports the change", () => {
    engine.insertText("x");
    expect(lastDirty(log, "a")).toBe(true);
    expect(log.docChanges).toContain("a");
  });

  it("becomes clean again when the edit is undone back to the saved point", () => {
    engine.insertText("x");
    engine.undo();
    expect(engine.getText("a")).toBe("saved text");
    expect(lastDirty(log, "a")).toBe(false);
    engine.redo();
    expect(engine.getText("a")).toBe("xsaved text");
    expect(lastDirty(log, "a")).toBe(true);
  });

  it("treats the state at save time as the new clean point", () => {
    engine.insertText("x");
    engine.markSaved("a");
    expect(lastDirty(log, "a")).toBe(false);
    engine.undo();
    // Undo past the save makes the text differ from disk again.
    expect(engine.getText("a")).toBe("saved text");
    expect(lastDirty(log, "a")).toBe(true);
    engine.redo();
    expect(lastDirty(log, "a")).toBe(false);
  });

  it("does not merge an edit after saving into the saved undo step", () => {
    engine.insertText("a");
    engine.markSaved("a");
    engine.insertText("b");
    engine.undo();
    expect(engine.getText("a")).toBe("asaved text");
    expect(lastDirty(log, "a")).toBe(false);
  });

  it("stays dirty after typing the same text that was deleted", () => {
    // Version tracking is by history position, not by text comparison.
    engine.restore("a", { anchor: 0, head: 5, scrollTop: 0 });
    engine.deleteSelection();
    engine.insertText("saved");
    expect(engine.getText("a")).toBe("saved text");
    expect(lastDirty(log, "a")).toBe(true);
  });

  it("never marks lazily appended file text as an edit", () => {
    engine.appendText("a", " and more");
    expect(engine.getText("a")).toBe("saved text and more");
    expect(log.dirty).toEqual([]);
    expect(log.docChanges).toEqual([]);
    // Appended text is not an undo step either.
    engine.undo();
    expect(engine.getText("a")).toBe("saved text and more");
  });

  it("appends to an inactive tab without touching the visible document", () => {
    engine.createDoc("b", "bg", "plain");
    engine.appendText("b", "+tail");
    expect(engine.getText("b")).toBe("bg+tail");
    expect(engine.getText("a")).toBe("saved text");
  });

  it("resetDoc replaces the text, clears undo and reports the tab clean", () => {
    engine.insertText("x");
    engine.resetDoc("a", "from disk");
    expect(engine.getText("a")).toBe("from disk");
    expect(lastDirty(log, "a")).toBe(false);
    engine.undo();
    expect(engine.getText("a")).toBe("from disk");
  });

  it("re-announces a dirty tab when it is activated again", () => {
    engine.insertText("x");
    engine.createDoc("b", "", "plain");
    engine.activate("b");
    log.dirty.length = 0;
    engine.activate("a");
    expect(log.dirty).toEqual([["a", true]]);
  });
});

describe("editor engine: editing helpers", () => {
  beforeEach(() => {
    mountEngine();
    engine.createDoc("a", "line 1\nline 2\nline 3", "plain");
    engine.activate("a");
  });

  it("goToLine clamps to the first and last line", () => {
    engine.goToLine(2);
    expect(engine.snapshot("a")?.head).toBe(7);
    engine.goToLine(99);
    expect(engine.snapshot("a")?.head).toBe(14);
    engine.goToLine(-5);
    expect(engine.snapshot("a")?.head).toBe(0);
    engine.goToLine(2.7);
    expect(engine.snapshot("a")?.head).toBe(7);
  });

  it("insertText replaces the selection", () => {
    engine.restore("a", { anchor: 0, head: 4, scrollTop: 0 });
    engine.insertText("row");
    expect(engine.getText("a")).toBe("row 1\nline 2\nline 3");
  });

  it("selectAll then deleteSelection empties the document", () => {
    engine.selectAll();
    expect(engine.selectionText()).toBe("line 1\nline 2\nline 3");
    engine.deleteSelection();
    expect(engine.getText("a")).toBe("");
  });

  it("selectionText is empty without a selection", () => {
    expect(engine.selectionText()).toBe("");
  });

  it("reports cursor line, column, length and selection size", async () => {
    const { log } = mountEngine();
    engine.createDoc("c", "ab\ncdé", "plain");
    engine.activate("c");
    engine.restore("c", { anchor: 3, head: 5, scrollTop: 0 });
    await nextFrame();
    const [, info] = log.cursor[log.cursor.length - 1];
    expect(info).toMatchObject({ line: 2, col: 3, chars: 6, selected: 2, canUndo: false });
  });

  it("applies a format command to the selection (mode checks live in the key handlers)", () => {
    engine.restore("a", { anchor: 0, head: 4, scrollTop: 0 });
    engine.format({ type: "bold" });
    expect(engine.getText("a").startsWith("**line**")).toBe(true);
  });
});

describe("editor engine: key bindings", () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    document
      .querySelector(".cm-content")!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

  beforeEach(() => {
    mountEngine();
  });

  it("Ctrl+B bolds the selection in a markdown tab", () => {
    engine.createDoc("a", "word", "formatted");
    engine.activate("a");
    engine.selectAll();
    press("b", { ctrlKey: true });
    expect(engine.getText("a")).toBe("**word**");
  });

  it("Ctrl+B and Ctrl+I never insert markdown into a plain-text tab", () => {
    engine.createDoc("a", "word", "plain");
    engine.activate("a");
    engine.selectAll();
    press("b", { ctrlKey: true });
    press("i", { ctrlKey: true });
    expect(engine.getText("a")).toBe("word");
  });

  it("Enter continues a bulleted list in a markdown tab", () => {
    engine.createDoc("a", "- first", "formatted");
    engine.activate("a");
    engine.restore("a", { anchor: 7, head: 7, scrollTop: 0 });
    press("Enter");
    expect(engine.getText("a")).toBe("- first\n- ");
  });

  it("Ctrl+Z and Ctrl+Y undo and redo typing", () => {
    engine.createDoc("a", "", "plain");
    engine.activate("a");
    engine.insertText("typed");
    press("z", { ctrlKey: true });
    expect(engine.getText("a")).toBe("");
    press("y", { ctrlKey: true });
    expect(engine.getText("a")).toBe("typed");
  });
});

describe("editor engine: modes and large documents", () => {
  beforeEach(() => {
    mountEngine();
  });

  it("switches between formatted, syntax and plain without changing the text", () => {
    engine.createDoc("a", "# Title\n**bold**", "formatted");
    engine.activate("a");
    for (const mode of ["syntax", "plain", "formatted"] as const) {
      engine.setMode("a", mode);
      expect(engine.getText("a")).toBe("# Title\n**bold**");
    }
    expect(document.querySelector(".cm-editor")?.className).toContain("cm-mode-formatted");
    engine.setMode("a", "plain");
    expect(document.querySelector(".cm-editor")?.className).toContain("cm-mode-plain");
  });

  it("falls back to syntax-level styling for a document with a very long line", () => {
    engine.createDoc("a", "x".repeat(20_001), "formatted");
    engine.activate("a");
    expect(document.querySelector(".cm-editor")?.className).toContain("cm-mode-syntax");
    expect(document.querySelector(".cm-editor")?.className).not.toContain("cm-mode-formatted");
  });

  it("degrades when an appended chunk makes the last line too long", () => {
    engine.createDoc("a", "short start ", "formatted");
    engine.activate("a");
    engine.appendText("a", "y".repeat(20_000));
    expect(document.querySelector(".cm-editor")?.className).toContain("cm-mode-syntax");
  });

  it("keeps a document of many short lines fully formatted", () => {
    engine.createDoc("a", "short line\n".repeat(5_000), "formatted");
    engine.activate("a");
    expect(document.querySelector(".cm-editor")?.className).toContain("cm-mode-formatted");
  });

  it("applies zoom and font settings as CSS variables, clamping zoom", () => {
    engine.setConfig({ zoom: 9999, fontSizePt: 12, fontWeight: 600, fontFamily: "Inter" });
    const style = (document.querySelector(".cm-editor") as HTMLElement).style;
    // 12pt = 16px, at the 500% ceiling.
    expect(style.getPropertyValue("--nl-font-size")).toBe("80.000px");
    expect(style.getPropertyValue("--nl-font-weight")).toBe("600");
    expect(style.getPropertyValue("--nl-font-family")).toBe("Inter");
  });

  it("turns spellcheck on and off on the editable surface", () => {
    engine.createDoc("a", "text", "plain");
    engine.activate("a");
    engine.setConfig({ spellcheck: true });
    expect(document.querySelector(".cm-content")?.getAttribute("spellcheck")).toBe("true");
    engine.setConfig({ spellcheck: false });
    expect(document.querySelector(".cm-content")?.getAttribute("spellcheck")).toBe("false");
  });

  it("turns Ctrl+wheel into a zoom request and ignores a plain wheel", () => {
    const { log } = mountEngine();
    const dom = document.querySelector(".cm-editor")!;
    dom.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true }));
    dom.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true }));
    dom.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true }));
    expect(log.zoom).toEqual([10, -10]);
  });
});

describe("editor engine: find through the engine", () => {
  beforeEach(() => {
    mountEngine();
    engine.createDoc("a", "one two one two one", "plain");
    engine.createDoc("b", "one", "plain");
    engine.activate("a");
  });

  it("finds, steps and replaces", () => {
    expect(engine.find({ search: "one", replace: "1", caseSensitive: false, wrap: true })).toEqual({
      total: 3,
      current: 1,
    });
    expect(engine.findNext()).toEqual({ total: 3, current: 2 });
    expect(engine.replaceAll()).toBe(3);
    expect(engine.getText("a")).toBe("1 two 1 two 1");
  });

  it("drops the find session when another tab is activated", () => {
    engine.find({ search: "one", replace: "", caseSensitive: false, wrap: true });
    engine.activate("b");
    expect(engine.findNext()).toEqual({ total: 0, current: 0 });
    expect(engine.replaceAll()).toBe(0);
    expect(engine.getText("b")).toBe("one");
  });
});
