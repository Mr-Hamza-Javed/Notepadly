// @vitest-environment jsdom
import { bootApp, settle, waitFor, type App } from "../test/appHarness";
import { backend, dialogs } from "../test/fakeTauri";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chordToCommand, isSuppressedDefault, type Chord, type Command } from "./shortcuts";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

const chord = (key: string, mods: Partial<Omit<Chord, "key">> = {}): Chord => ({
  key,
  ctrl: false,
  shift: false,
  alt: false,
  ...mods,
});

/** Parses a menu label such as "Ctrl+Shift+S" or "Ctrl+Plus" into the key event it stands for. */
function labelToChord(label: string): Chord {
  const parts = label.split("+");
  const name = parts[parts.length - 1];
  const key = name === "Plus" ? "+" : name === "Minus" ? "-" : name.length === 1 ? name.toLowerCase() : name;
  return chord(key, { ctrl: parts.includes("Ctrl"), shift: parts.includes("Shift"), alt: parts.includes("Alt") });
}

describe("key chords", () => {
  it("maps the File menu keys", () => {
    expect(chordToCommand(chord("n", { ctrl: true }))).toBe("newTab");
    expect(chordToCommand(chord("N", { ctrl: true, shift: true }))).toBe("newWindow");
    expect(chordToCommand(chord("s", { ctrl: true, alt: true }))).toBe("saveAll");
    expect(chordToCommand(chord("s", { ctrl: true, alt: true, shift: true }))).toBeNull();
    expect(chordToCommand(chord("W", { ctrl: true, shift: true }))).toBe("closeWindow");
  });

  it("accepts both Ctrl+Y and Ctrl+Shift+Z for redo", () => {
    expect(chordToCommand(chord("y", { ctrl: true }))).toBe("redo");
    expect(chordToCommand(chord("Z", { ctrl: true, shift: true }))).toBe("redo");
  });

  it("zooms with the main keyboard and number pad keys", () => {
    for (const key of ["+", "="]) expect(chordToCommand(chord(key, { ctrl: true }))).toBe("zoomIn");
    expect(chordToCommand(chord("+", { ctrl: true, shift: true }))).toBe("zoomIn");
    for (const key of ["-", "_"]) expect(chordToCommand(chord(key, { ctrl: true }))).toBe("zoomOut");
    expect(chordToCommand(chord("0", { ctrl: true }))).toBe("zoomReset");
  });

  it("switches tabs by number, with 9 meaning the last tab", () => {
    expect(chordToCommand(chord("1", { ctrl: true }))).toBe("tab1");
    expect(chordToCommand(chord("8", { ctrl: true }))).toBe("tab8");
    expect(chordToCommand(chord("9", { ctrl: true }))).toBe("tabLast");
    expect(chordToCommand(chord("Tab", { ctrl: true }))).toBe("nextTab");
    expect(chordToCommand(chord("Tab", { ctrl: true, shift: true }))).toBe("prevTab");
  });

  it("maps the function keys", () => {
    expect(chordToCommand(chord("F3"))).toBe("findNext");
    expect(chordToCommand(chord("F3", { shift: true }))).toBe("findPrev");
    expect(chordToCommand(chord("F5"))).toBe("dateTime");
    expect(chordToCommand(chord("F1"))).toBe("help");
    expect(chordToCommand(chord("F5", { shift: true }))).toBeNull();
  });

  it("leaves AltGr characters and plain typing alone", () => {
    // AltGr arrives as Ctrl+Alt on Windows: only Ctrl+Alt+S is ours.
    expect(chordToCommand(chord("e", { ctrl: true, alt: true }))).toBeNull();
    expect(chordToCommand(chord("s", { alt: true }))).toBeNull();
    expect(chordToCommand(chord("a"))).toBeNull();
    expect(chordToCommand(chord("Enter"))).toBeNull();
  });

  // BUGS.md UI-1: with an Urdu, Arabic or Russian layout Chromium reports the layout's
  // letter (Ctrl+S gives key "س"), but Windows accelerators work by the physical key.
  it("works with a keyboard layout that types another script", () => {
    expect(chordToCommand(chord("س", { ctrl: true, code: "KeyS" }))).toBe("save");
    expect(chordToCommand(chord("ы", { ctrl: true, code: "KeyS" }))).toBe("save");
    expect(chordToCommand(chord("ن", { ctrl: true, shift: true, code: "KeyN" }))).toBe("newWindow");
    expect(chordToCommand(chord("س", { ctrl: true, alt: true, code: "KeyS" }))).toBe("saveAll");
    // Typing Urdu without Ctrl stays typing.
    expect(chordToCommand(chord("س", { code: "KeyS" }))).toBeNull();
    // Ctrl+P and Ctrl+F must not reach WebView2's print dialog or find bar either.
    expect(isSuppressedDefault(chord("پ", { ctrl: true, code: "KeyP" }), true)).toBe(true);
    expect(isSuppressedDefault(chord("ف", { ctrl: true, code: "KeyF" }), true)).toBe(true);
    // A layout that types Latin letters keeps its own letter (AZERTY Ctrl+A is "a" on the Q key).
    expect(chordToCommand(chord("a", { ctrl: true, code: "KeyQ" }))).toBe("selectAll");
  });

  it("does not take clipboard keys from the editor", () => {
    for (const key of ["x", "c", "v"]) expect(chordToCommand(chord(key, { ctrl: true }))).toBeNull();
  });
});

describe("WebView defaults that must never reach the user", () => {
  it("blocks reload, caret browsing, browser navigation and page zoom", () => {
    for (const c of [
      chord("F5"),
      chord("F7"),
      chord("r", { ctrl: true }),
      chord("BrowserBack"),
      chord("ArrowLeft", { alt: true }),
      chord("+", { ctrl: true }),
      chord("0", { ctrl: true }),
      chord("p", { ctrl: true }),
      chord("f", { ctrl: true }),
      chord("j", { ctrl: true }),
      chord("F3"),
      chord("F3", { shift: true }),
    ]) {
      expect(isSuppressedDefault(c, false), JSON.stringify(c)).toBe(true);
    }
  });

  it("allows developer tools only in development builds", () => {
    expect(isSuppressedDefault(chord("F12"), true)).toBe(true);
    expect(isSuppressedDefault(chord("F12"), false)).toBe(false);
    expect(isSuppressedDefault(chord("I", { ctrl: true, shift: true }), true)).toBe(true);
    expect(isSuppressedDefault(chord("I", { ctrl: true, shift: true }), false)).toBe(false);
  });

  it("keeps editing keys working", () => {
    for (const c of [chord("c", { ctrl: true }), chord("v", { ctrl: true }), chord("a"), chord("ArrowLeft"), chord("Backspace")]) {
      expect(isSuppressedDefault(c, true), JSON.stringify(c)).toBe(false);
    }
  });
});

// One app per file: every boot installs window-level key listeners that stay.
let app: App;
beforeAll(async () => {
  app = await bootApp();
});

describe("menu shortcut labels", () => {
  it("every label in the menus triggers the same command from the keyboard", async () => {
    const { buildMenu } = await import("../components/menus");
    const expected: Record<string, Command | null> = {
      new: "newTab",
      win: "newWindow",
      open: "open",
      save: "save",
      saveas: "saveAs",
      saveall: "saveAll",
      print: "print",
      closetab: "closeTab",
      closewin: "closeWindow",
      undo: "undo",
      // Clipboard and Delete are the editor's own keys.
      cut: null,
      copy: null,
      paste: null,
      del: null,
      bing: "searchWeb",
      find: "find",
      next: "findNext",
      prev: "findPrev",
      replace: "replace",
      goto: "goTo",
      all: "selectAll",
      date: "dateTime",
      in: "zoomIn",
      out: "zoomOut",
      reset: "zoomReset",
    };
    const labelled: string[] = [];
    const visit = (entries: ReturnType<typeof buildMenu>) => {
      for (const entry of entries) {
        if ("submenu" in entry && entry.submenu) visit(entry.submenu);
        if ("shortcut" in entry && entry.shortcut && "id" in entry) {
          labelled.push(entry.id);
          expect(entry.id in expected, `unexpected shortcut on ${entry.id}`).toBe(true);
          const command = entry.shortcut === "Del" ? null : chordToCommand(labelToChord(entry.shortcut));
          expect(command, `${entry.id}: ${entry.shortcut}`).toBe(expected[entry.id]);
        }
      }
    };
    for (const id of ["file", "edit", "view"] as const) visit(buildMenu(id));
    expect(labelled.sort()).toEqual(Object.keys(expected).sort());
  });
});

describe("keyboard handling in the window", () => {
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.querySelector(".cm-content")!) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(async () => {
    app.actions.closeDialog();
    app.actions.closeFind();
    app.actions.closeSettings();
    while (app.state().tabs.length > 1) {
      const closing = app.actions.closeTab(app.state().tabs[0].id);
      await settle();
      const dialog = app.state().dialog;
      if (dialog?.kind === "confirm-close") dialog.resolve("discard");
      await closing;
    }
    app.engine.selectAll();
    app.engine.deleteSelection();
    app.actions.setMode(app.tab().id, "formatted");
  });

  it("Ctrl+N opens a new tab and blocks the WebView default", async () => {
    const event = press("n", { ctrlKey: true });
    await settle();
    expect(app.state().tabs).toHaveLength(2);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores auto-repeat for commands that must run once", async () => {
    press("n", { ctrlKey: true, repeat: true });
    await settle();
    expect(app.state().tabs).toHaveLength(1);
  });

  it("F5 inserts the time and date at the cursor", () => {
    press("F5");
    // The format follows the locale (BUGS.md L4): time, then the date with a four-digit year.
    expect(app.text()).toMatch(/^\d{1,2}[:.]\d{2}\b.*\d{4}/);
  });

  it("Ctrl+B is ignored in plain-text tabs", () => {
    app.actions.setMode(app.tab().id, "plain");
    app.engine.insertText("word");
    app.engine.selectAll();
    press("b", { ctrlKey: true });
    expect(app.text()).toBe("word");
  });

  it("Ctrl+B bolds in formatted tabs", () => {
    app.engine.insertText("word");
    app.engine.selectAll();
    press("b", { ctrlKey: true });
    expect(app.text()).toBe("**word**");
  });

  it("Ctrl+F opens find and Escape closes it", () => {
    press("f", { ctrlKey: true });
    expect(app.state().find).toEqual({ open: true, replace: false });
    press("Escape");
    expect(app.state().find.open).toBe(false);
  });

  it("Ctrl+H opens find with replace", () => {
    press("h", { ctrlKey: true });
    expect(app.state().find).toEqual({ open: true, replace: true });
  });

  it("Escape closes a dialog before anything else", () => {
    press("f", { ctrlKey: true });
    app.actions.showDialog({ kind: "goto" });
    press("Escape");
    expect(app.state().dialog).toBeNull();
    expect(app.state().find.open).toBe(true);
  });

  it("app shortcuts do nothing while a dialog is open", async () => {
    app.actions.showDialog({ kind: "goto" });
    press("n", { ctrlKey: true });
    await settle();
    expect(app.state().tabs).toHaveLength(1);
  });

  it("Ctrl+Z inside a text box is left to the text box", () => {
    app.engine.insertText("typed");
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("z", { ctrlKey: true }, input);
    expect(app.text()).toBe("typed");
    input.remove();
  });

  // BUGS.md L15: editing shortcuts typed in the Find box must not change the document.
  it("Ctrl+B, Ctrl+I, Ctrl+K and F5 in a text box leave the document alone", () => {
    app.engine.insertText("word");
    app.engine.selectAll();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("b", { ctrlKey: true }, input);
    press("i", { ctrlKey: true }, input);
    press("k", { ctrlKey: true }, input);
    const f5 = press("F5", {}, input);
    expect(app.text()).toBe("word");
    expect(app.state().dialog).toBeNull();
    // F5 still never reloads the page.
    expect(f5.defaultPrevented).toBe(true);
    input.remove();
  });

  // BUGS.md H10 (part 2): F3 moved the match but the find bar's counter stayed behind.
  it("F3 and Shift+F3 with the find bar open go through the find bar", async () => {
    // The app was booted on fresh modules: use the find bar glue it loaded.
    const { setFindStepHandler } = await import("./findBar");
    const steps: number[] = [];
    setFindStepHandler((dir) => steps.push(dir));
    try {
      press("f", { ctrlKey: true });
      press("F3");
      press("F3", { shiftKey: true });
      expect(steps).toEqual([1, -1]);
    } finally {
      setFindStepHandler(null);
    }
  });

  it("UI-1: Ctrl+N works with an Urdu keyboard layout", async () => {
    const event = press("ن", { ctrlKey: true, code: "KeyN" });
    await settle();
    expect(app.state().tabs).toHaveLength(2);
    expect(event.defaultPrevented).toBe(true);
  });

  it("UI-1: Alt+F opens the File menu with an Urdu keyboard layout", async () => {
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { MenuBar } = await import("../components/MenuBar");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView ??= () => {};
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(MenuBar)));
    try {
      await act(async () => {
        press("ف", { altKey: true, code: "KeyF" });
      });
      expect(host.querySelector("[role='menu']")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("Ctrl+plus and Ctrl+minus zoom", () => {
    app.actions.zoomReset();
    press("=", { ctrlKey: true });
    expect(app.state().settings.zoom).toBe(110);
    press("-", { ctrlKey: true });
    press("-", { ctrlKey: true });
    expect(app.state().settings.zoom).toBe(90);
    app.actions.zoomReset();
  });

  // Smaller open points: Ctrl+wheel outside the editor zoomed 10% per event, so a pinch jumped.
  it("Ctrl+wheel outside the editor zooms one step per notch, not per event", () => {
    app.actions.zoomReset();
    const wheel = (deltaY: number, timeStamp: number) => {
      const event = new WheelEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
      document.body.dispatchEvent(event);
      return event;
    };
    // A touchpad pinch: twenty small events make one notch's worth.
    for (let i = 0; i < 20; i++) expect(wheel(-5, 1000 + i).defaultPrevented).toBe(true);
    expect(app.state().settings.zoom).toBe(110);
    // A mouse notch zooms one step.
    wheel(100, 5000);
    expect(app.state().settings.zoom).toBe(100);
    app.actions.zoomReset();
  });

  it("Ctrl+9 jumps to the last tab and Ctrl+1 to the first", async () => {
    await app.actions.newTab();
    await app.actions.newTab();
    const ids = app.state().tabs.map((t) => t.id);
    press("1", { ctrlKey: true });
    await settle();
    expect(app.state().activeId).toBe(ids[0]);
    press("9", { ctrlKey: true });
    await settle();
    expect(app.state().activeId).toBe(ids[2]);
    press("5", { ctrlKey: true }); // no fifth tab: nothing happens
    await settle();
    expect(app.state().activeId).toBe(ids[2]);
  });

  it("Ctrl+S saves a new tab through the Save as dialog", async () => {
    app.engine.insertText("keyboard save");
    backend.mkdir("C:\\keys");
    dialogs.saveAnswers.push("C:\\keys\\saved.md");
    press("s", { ctrlKey: true });
    await waitFor(() => backend.exists("C:\\keys\\saved.md"));    expect(backend.text("C:\\keys\\saved.md")).toBe("keyboard save");
    expect(app.tab()).toMatchObject({ title: "saved.md", dirty: false });
  });

  it("does not open the WebView context menu outside text", () => {
    const outside = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(true);
    const inside = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.querySelector(".cm-content")!.dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(false);
  });

  // BUGS.md W3: rendered parts inside the editor showed "Refresh", "Back" and "Save as".
  it("does not open the WebView context menu on rendered parts inside the editor", () => {
    const content = document.querySelector(".cm-content")!;
    const add = (html: string) => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      return content.appendChild(holder.firstElementChild!);
    };
    const parts = [
      add('<div contenteditable="false" class="table"><table><tbody><tr><td contenteditable="plaintext-only">cell</td></tr></tbody></table></div>'),
      add('<span contenteditable="false" class="math"><span class="katex">x</span></span>'),
      add('<div contenteditable="false" class="diagram"><svg><g><text>A</text></g></svg></div>'),
      add('<span contenteditable="false" class="image"><img alt=""></span>'),
      add('<span contenteditable="false"><input type="checkbox"></span>'),
    ];
    const rightClick = (target: Element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      expect(rightClick(parts[0].querySelector("table")!), "table border").toBe(true);
      expect(rightClick(parts[1].querySelector(".katex")!), "maths").toBe(true);
      expect(rightClick(parts[2].querySelector("text")!), "diagram").toBe(true);
      expect(rightClick(parts[3].querySelector("img")!), "image").toBe(true);
      expect(rightClick(parts[4].querySelector("input")!), "checkbox").toBe(true);
      // Text keeps the WebView's Cut / Copy / Paste menu: editor lines, cells and text boxes.
      expect(rightClick(content), "editor text").toBe(false);
      const input = document.body.appendChild(document.createElement("input"));
      expect(rightClick(input), "text box").toBe(false);
      input.remove();
    } finally {
      parts.forEach((part) => part.remove());
    }
  });

  it("a real rendered table's border does not open the WebView context menu", async () => {
    app.engine.insertText("| a | b |\n| - | - |\n| 1 | 2 |\n\ntext");
    await settle(50);
    const table = document.querySelector(".cm-content table");
    expect(table).not.toBeNull();
    const cell = table!.querySelector("td")!;
    const onCell = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    cell.dispatchEvent(onCell);
    // A cell is text (the table's own menu, if mounted, handles it).
    expect(onCell.defaultPrevented).toBe(false);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    table!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("blocks the Refresh key, F5 with modifiers and Ctrl+R everywhere", () => {
    for (const c of [chord("BrowserRefresh"), chord("F5", { ctrl: true }), chord("F5", { shift: true }), chord("r", { ctrl: true }), chord("R", { ctrl: true, shift: true })]) {
      expect(isSuppressedDefault(c, true), JSON.stringify(c)).toBe(true);
    }
  });
});
