// @vitest-environment jsdom
// End-to-end behaviour of tabs, opening, saving, closing and settings: the real
// store, actions, loader and CodeMirror engine against an in-memory backend.
import { bootApp, settle, waitFor, type App } from "../test/appHarness";
import { backend, dialogs, fakeWindow } from "../test/fakeTauri";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

const A = "C:\\notes\\a.md";
const B = "C:\\notes\\b.txt";

let app: App;

describe("starting up", () => {
  it("starts with one empty untitled tab in formatted mode", async () => {
    app = await bootApp();
    expect(app.state().tabs).toHaveLength(1);
    expect(app.tab()).toMatchObject({ title: "Untitled", path: null, dirty: false, mode: "formatted" });
    expect(app.text()).toBe("");
  });

  it("starts new tabs in plain mode when Formatting is off", async () => {
    app = await bootApp({ settings: { formatting: false } });
    expect(app.tab().mode).toBe("plain");
  });

  it("opens files passed on the command line", async () => {
    backend.reset();
    backend.write(A, "# From argv");
    backend.pendingPaths = [A];
    app = await bootApp({ keepDisk: true });
    expect(app.tab()).toMatchObject({ path: A, title: "a.md" });
    expect(app.text()).toBe("# From argv");
    // The empty untitled tab it replaced is gone.
    expect(app.state().tabs).toHaveLength(1);
  });
});

describe("opening files", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(A, "# Title\n\nBody text");
    backend.write(B, "plain text");
  });

  it("opens a markdown file formatted and a text file plain", async () => {
    await app.actions.openPaths([A]);
    expect(app.tab()).toMatchObject({ path: A, title: "a.md", mode: "formatted", dirty: false, fullyLoaded: true });
    expect(app.text()).toBe("# Title\n\nBody text");
    await app.actions.openPaths([B]);
    expect(app.tab()).toMatchObject({ title: "b.txt", mode: "plain" });
  });

  it("replaces the pristine untitled tab instead of adding next to it", async () => {
    await app.actions.openPaths([A]);
    expect(app.state().tabs.map((t) => t.title)).toEqual(["a.md"]);
  });

  it("keeps an untitled tab that has text in it", async () => {
    app.type("my note");
    await app.actions.openPaths([A]);
    expect(app.state().tabs).toHaveLength(2);
  });

  it("switches to an already open file instead of opening it twice", async () => {
    await app.actions.openPaths([A]);
    await app.actions.newTab();
    await app.actions.openPaths(["c:/NOTES/A.MD"]);
    expect(app.state().tabs.filter((t) => t.path !== null)).toHaveLength(1);
    expect(app.tab().path).toBe(A);
  });

  it("opens several files at once, activating the last", async () => {
    await app.actions.openPaths([A, B]);
    expect(app.state().tabs.map((t) => t.title)).toEqual(["a.md", "b.txt"]);
    expect(app.tab().title).toBe("b.txt");
    // The other one loads when it is first activated.
    const a = app.tabByName("a.md");
    await app.actions.activate(a.id);
    expect(app.text(a.id)).toBe("# Title\n\nBody text");
  });

  it("adds opened files to the front of the recent list", async () => {
    await app.actions.openPaths([B]);
    await app.actions.openPaths([A]);
    expect(app.state().recent).toEqual([A, B]);
  });

  it("does not track recent files when the setting is off", async () => {
    app = await bootApp({ settings: { recentFiles: false } });
    backend.write(A, "x");
    await app.actions.openPaths([A]);
    expect(app.state().recent).toEqual([]);
  });

  it("reports a missing file, opens no tab and drops it from recent", async () => {
    app = await bootApp({ recent: ["C:\\gone.md", A] });
    backend.write(A, "x");
    await app.actions.openPaths(["C:\\gone.md"]);
    expect(app.message()?.title).toBe("Could not open file");
    expect(app.message()?.body).toContain("C:\\gone.md");
    expect(app.state().tabs.map((t) => t.title)).toEqual(["Untitled"]);
    expect(app.state().recent).toEqual([A]);
  });

  // Regression for BUGS.md M20: the message named the last path in the list,
  // not the file that failed, and the failed file stayed in Recent.
  it("names the file that could not be read and drops it from recent", async () => {
    backend.unreadable.add(A.toLowerCase());
    await app.actions.openPaths([A, "C:\\missing.md"]);
    const message = app.message();
    expect(message?.title).toBe("Could not open file");
    expect(message?.body).toContain("a.md:");
    expect(message?.body).not.toContain("missing.md:");
    expect(app.state().recent).not.toContain(A);
    expect(app.state().tabs.map((t) => t.title)).toEqual(["Untitled"]);
  });

  it("opens files with spaces, Urdu and emoji in the path", async () => {
    const path = "D:\\My Notes\\اردو 😀 notes.md";
    backend.write(path, "سلام");
    await app.actions.openPaths([path]);
    expect(app.tab()).toMatchObject({ path, title: "اردو 😀 notes.md" });
    expect(app.text()).toBe("سلام");
  });

  it("opens files in a new window when that setting is on, except ones already open", async () => {
    app = await bootApp({ settings: { openFilesIn: "window" } });
    backend.write(A, "a");
    backend.write(B, "b");
    await app.actions.openPaths([A, B]);
    const call = backend.calls.find((c) => c.cmd === "window_new");
    expect(call?.args).toEqual({ paths: [A, B] });
    expect(app.state().tabs).toHaveLength(1);
  });

  it("opens from the Open dialog", async () => {
    dialogs.openAnswers.push([B]);
    await app.actions.openDialog();
    expect(app.tab().title).toBe("b.txt");
  });
});

describe("line endings and encodings", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  it("shows CRLF text with plain newlines and writes CRLF back byte for byte", async () => {
    backend.write(A, "one\r\ntwo\r\n");
    await app.actions.openPaths([A]);
    expect(app.text()).toBe("one\ntwo\n");
    expect(app.tab().eol).toBe("CRLF");
    app.type("three");
    await app.actions.save();
    expect(backend.text(A)).toBe("one\r\ntwo\r\nthree");
  });

  it("keeps LF files LF", async () => {
    backend.write(A, "one\ntwo");
    await app.actions.openPaths([A]);
    expect(app.tab().eol).toBe("LF");
    app.type("!");
    await app.actions.save();
    expect(backend.text(A)).toBe("one\ntwo!");
  });

  it("keeps a UTF-8 BOM through a save", async () => {
    backend.write(A, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("bom")]));
    await app.actions.openPaths([A]);
    expect(app.text()).toBe("bom");
    expect(app.tab().encoding).toBe("utf-8-bom");
    app.type("!");
    await app.actions.save();
    expect(Array.from(backend.bytes(A).subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(backend.text(A)).toBe("\uFEFFbom!");
  });

  it("changing the line ending marks the tab dirty and is written on save", async () => {
    backend.write(A, "a\nb");
    await app.actions.openPaths([A]);
    await app.actions.setEol("CRLF");
    expect(app.tab()).toMatchObject({ eol: "CRLF", dirty: true });
    await app.actions.save();
    expect(backend.text(A)).toBe("a\r\nb");
    expect(app.tab().dirty).toBe(false);
  });

  it("choosing the line ending a file already has changes nothing", async () => {
    backend.write(A, "a\nb");
    await app.actions.openPaths([A]);
    await app.actions.setEol("LF");
    expect(app.tab().dirty).toBe(false);
  });

  it("changing the encoding adds a BOM on save", async () => {
    backend.write(A, "x");
    await app.actions.openPaths([A]);
    await app.actions.setEncoding("utf-8-bom");
    expect(app.tab().dirty).toBe(true);
    await app.actions.save();
    expect(backend.text(A)).toBe("\uFEFFx");
  });

  it("round-trips Urdu and emoji text", async () => {
    const text = "پہلی لائن 😀\r\nدوسری لائن";
    backend.write(A, text);
    await app.actions.openPaths([A]);
    app.type(" ✓");
    await app.actions.save();
    expect(backend.text(A)).toBe(`${text} ✓`);
  });
});

describe("dirty state and saving", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(A, "saved");
    await app.actions.openPaths([A]);
  });

  it("marks a tab dirty on edit and clean after saving", async () => {
    app.type(" more");
    expect(app.tab().dirty).toBe(true);
    expect(await app.actions.save()).toBe(true);
    expect(app.tab().dirty).toBe(false);
    expect(backend.text(A)).toBe("saved more");
  });

  it("does not write a clean tab", async () => {
    const before = backend.count("file_save");
    expect(await app.actions.save()).toBe(true);
    expect(backend.count("file_save")).toBe(before);
  });

  it("becomes clean when the edit is undone", async () => {
    app.type("x");
    app.engine.undo();
    expect(app.tab().dirty).toBe(false);
  });

  it("reports a failed save and keeps the tab dirty", async () => {
    app.type("!");
    backend.failNext.set("file_save", "Access is denied. (os error 5)");
    expect(await app.actions.save()).toBe(false);
    expect(app.message()).toMatchObject({ title: "Could not save file" });
    expect(app.message()?.body).toContain("Access is denied");
    expect(app.tab().dirty).toBe(true);
    expect(backend.text(A)).toBe("saved");
  });

  it("refuses to overwrite a file another program changed, and says so", async () => {
    app.type(" mine");
    backend.write(A, "theirs");
    expect(await app.actions.save()).toBe(false);
    expect(app.message()?.title).toBe("File changed on disk");
    expect(app.tab().externalChange).toBe("modified");
    expect(backend.text(A)).toBe("theirs");
  });

  it("can save after choosing Keep mine", async () => {
    app.type(" mine");
    backend.write(A, "theirs");
    await app.actions.save();
    await app.actions.keepMine(app.tab().id);
    expect(app.tab().externalChange).toBeNull();
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("saved mine");
  });

  it("saves all dirty tabs", async () => {
    backend.write(B, "b");
    await app.actions.openPaths([B]);
    app.type("2");
    await app.actions.activate(app.tabByName("a.md").id);
    app.type("1");
    await app.actions.saveAll();
    expect(backend.text(A)).toBe("saved1");
    expect(backend.text(B)).toBe("b2");
    expect(app.state().tabs.every((t) => !t.dirty)).toBe(true);
  });
});

describe("save as", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.mkdir("C:\\notes");
  });

  it("reports a folder that no longer exists and keeps the tab unsaved", async () => {
    app.type("text");
    dialogs.saveAnswers.push("C:\\gone\\x.md");
    expect(await app.actions.saveAs()).toBe(false);
    expect(app.message()).toMatchObject({
      title: "Could not save file",
      body: "The system cannot find the path specified. (os error 3)",
    });
    expect(app.tab()).toMatchObject({ path: null, dirty: true });
  });

  it("asks for a name for an untitled tab and suggests one from its first line", async () => {
    app.type("# Shopping list\nmilk");
    await waitFor(() => app.tab().title === "Shopping list");
    dialogs.saveAnswers.push("C:\\notes\\shopping.md");
    expect(await app.actions.save()).toBe(true);
    expect(dialogs.saveRequests[0].defaultPath).toBe("Shopping list.md");
    expect(backend.text("C:\\notes\\shopping.md")).toBe("# Shopping list\r\nmilk");
    expect(app.tab()).toMatchObject({ path: "C:\\notes\\shopping.md", title: "shopping.md", dirty: false });
    expect(app.state().recent[0]).toBe("C:\\notes\\shopping.md");
  });

  it("does nothing when the dialog is cancelled", async () => {
    app.type("text");
    expect(await app.actions.save()).toBe(false);
    expect(app.tab()).toMatchObject({ path: null, dirty: true });
    expect(backend.count("file_save")).toBe(0);
  });

  // BUGS.md C1: the dialog adds the filter's extension itself; with "All files"
  // a name without one is what the user wants, and LICENSE.md must stay untouched.
  it("saves a name without an extension as chosen and leaves name.md alone", async () => {
    backend.write("C:\\notes\\LICENSE.md", "IMPORTANT EXISTING CONTENT");
    app.type("hello");
    dialogs.saveAnswers.push("C:\\notes\\LICENSE");
    expect(await app.actions.saveAs()).toBe(true);
    expect(backend.text("C:\\notes\\LICENSE")).toBe("hello");
    expect(backend.text("C:\\notes\\LICENSE.md")).toBe("IMPORTANT EXISTING CONTENT");
    expect(app.tab()).toMatchObject({ path: "C:\\notes\\LICENSE", title: "LICENSE", mode: "plain" });
  });

  // BUGS.md M6: Save As onto a file open in another tab left two tabs for one file.
  it("M6: replaces a clean tab of the file it saves over", async () => {
    backend.write(B, "old b");
    await app.actions.openPaths([B]);
    await app.actions.newTab();
    app.type("new b");
    dialogs.saveAnswers.push(B);
    expect(await app.actions.saveAs()).toBe(true);
    expect(backend.text(B)).toBe("new b");
    const tabs = app.state().tabs.filter((t) => t.path === B);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe(app.state().activeId);
    expect(app.text()).toBe("new b");
  });

  it("M6: refuses to save over a file whose tab has unsaved changes", async () => {
    backend.write(B, "old b");
    await app.actions.openPaths([B]);
    app.type(" edited");
    await app.actions.newTab();
    app.type("other");
    dialogs.saveAnswers.push(B);
    expect(await app.actions.saveAs()).toBe(false);
    expect(app.message()?.body).toContain("b.txt is open in another tab with unsaved changes");
    expect(backend.text(B)).toBe("old b");
    expect(app.tab()).toMatchObject({ path: null, dirty: true });
    expect(app.tabByName("b.txt").dirty).toBe(true);
  });

  // BUGS.md T4: Windows writes "notes." as "notes"; the tab must name that file.
  it("drops a trailing dot from the chosen name", async () => {
    app.type("x");
    dialogs.saveAnswers.push("C:\\notes\\notes.");
    expect(await app.actions.saveAs()).toBe(true);
    expect(backend.exists("C:\\notes\\notes")).toBe(true);
    expect(app.tab()).toMatchObject({ path: "C:\\notes\\notes", title: "notes" });
    await app.actions.openPaths(["C:\\notes\\notes"]);
    expect(app.state().tabs).toHaveLength(1);
  });

  it("switches to plain mode when saved under a non-markdown name", async () => {
    app.type("x");
    dialogs.saveAnswers.push("C:\\notes\\x.txt");
    await app.actions.saveAs();
    expect(app.tab().mode).toBe("plain");
  });

  it("suggests the current folder and name for a saved file", async () => {
    backend.write(A, "x");
    await app.actions.openPaths([A]);
    backend.mkdir("C:\\other");
    dialogs.saveAnswers.push("C:\\other\\copy.md");
    await app.actions.saveAs();
    expect(dialogs.saveRequests[0].defaultPath).toBe(A);
    expect(backend.text("C:\\other\\copy.md")).toBe("x");
    expect(backend.text(A)).toBe("x");
    expect(app.tab().path).toBe("C:\\other\\copy.md");
  });
});

describe("files changed by other programs", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(A, "original");
    await app.actions.openPaths([A]);
  });

  it("silently reloads a clean tab", async () => {
    backend.write(A, "changed outside");
    await app.loader.pollExternalChanges();
    await waitFor(() => app.text() === "changed outside");
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
  });

  it("flags a dirty tab instead of throwing away the user's text", async () => {
    app.type(" edited");
    backend.write(A, "changed outside");
    await app.loader.pollExternalChanges();
    expect(app.tab().externalChange).toBe("modified");
    expect(app.text()).toBe("original edited");
  });

  it("reloads the disk version on request", async () => {
    app.type(" edited");
    backend.write(A, "changed outside");
    await app.loader.pollExternalChanges();
    await app.actions.reloadTab(app.tab().id);
    expect(app.text()).toBe("changed outside");
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
  });

  it("flags a deleted file and marks it unsaved, so closing asks first", async () => {
    backend.delete(A);
    await app.loader.pollExternalChanges();
    expect(app.tab()).toMatchObject({ externalChange: "deleted", dirty: true });
    expect(app.text()).toBe("original");
  });

  it("recreates a deleted file on save", async () => {
    backend.delete(A);
    await app.loader.pollExternalChanges();
    await app.actions.keepMine(app.tab().id);
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("original");
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
  });

  it("does nothing when the file is unchanged", async () => {
    await app.loader.pollExternalChanges();
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
    expect(backend.count("file_read_chunk")).toBe(1);
  });

  it("ignores a disk change that Keep mine already dismissed", async () => {
    app.type("!");
    backend.write(A, "changed outside");
    await app.loader.pollExternalChanges();
    await app.actions.keepMine(app.tab().id);
    await app.loader.pollExternalChanges();
    expect(app.tab().externalChange).toBeNull();
  });

  // BUGS.md H7: a file that is deleted and recreated (git checkout, OneDrive)
  // leaves a clean tab marked unsaved.
  it.skip("H7: a deleted-then-restored file leaves an unedited tab clean", async () => {
    backend.delete(A);
    await app.loader.pollExternalChanges();
    backend.write(A, "original");
    await app.loader.pollExternalChanges();
    await settle(20);
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
  });
});

describe("large files", () => {
  const line = "0123456789".repeat(9) + "\n"; // 91 bytes
  const big = line.repeat(25_000); // ~2.3 MB, just above the 2 MiB idle-load limit

  beforeEach(async () => {
    app = await bootApp();
    backend.write(A, big);
    await app.actions.openPaths([A]);
  });

  it("shows only the first chunk of a big file, cut on a line boundary", () => {
    const tab = app.tab();
    expect(tab.fullyLoaded).toBe(false);
    expect(tab.loadedOffset).toBeLessThanOrEqual(256 * 1024);
    expect(tab.loadedOffset % line.length).toBe(0);
    expect(app.text()).toBe(big.slice(0, tab.loadedOffset));
  });

  it("loads the rest on demand", async () => {
    await app.actions.ensureFullyLoaded(app.tab().id);
    expect(app.tab()).toMatchObject({ fullyLoaded: true, loadedOffset: big.length });
    expect(app.text()).toBe(big);
    expect(app.tab().dirty).toBe(false);
  });

  it("saves an edit without loading the rest, keeping the unloaded tail byte for byte", async () => {
    const loaded = app.tab().loadedOffset;
    app.engine.restore(app.tab().id, { anchor: 0, head: 0, scrollTop: 0 });
    app.engine.insertText("EDIT\n");
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("EDIT\n" + big);
    expect(app.tab()).toMatchObject({ dirty: false, fullyLoaded: false, loadedOffset: loaded + 5 });
    // Loading continues from the right place afterwards.
    await app.actions.ensureFullyLoaded(app.tab().id);
    expect(app.text()).toBe("EDIT\n" + big);
  });

  it("refuses to save a partly loaded file whose disk copy changed", async () => {
    app.type("x");
    backend.write(A, "replaced by another program");
    expect(await app.actions.save()).toBe(false);
    expect(backend.text(A)).toBe("replaced by another program");
  });

  // BUGS.md C3: Save failed with "use Save as", and Save As failed with "Reload it".
  it("C3: saves the loaded part elsewhere once the disk copy changed, after asking", async () => {
    const loaded = app.tab().loadedOffset;
    app.engine.restore(app.tab().id, { anchor: 0, head: 0, scrollTop: 0 });
    app.engine.insertText("EDIT\n");
    backend.write(A, "replaced by another program");
    expect(await app.actions.save()).toBe(false);
    expect(app.message()?.title).toBe("File changed on disk");
    app.actions.closeDialog();
    await app.actions.keepMine(app.tab().id);

    // Cancelled: nothing is written.
    dialogs.saveAnswers.push("C:\\notes\\copy.md");
    expect(await app.actions.saveAs()).toBe(false);
    expect(dialogs.messages[0].title).toBe("File changed on disk");
    expect(backend.exists("C:\\notes\\copy.md")).toBe(false);

    dialogs.saveAnswers.push("C:\\notes\\copy.md");
    dialogs.messageAnswers.push("Save loaded part");
    expect(await app.actions.saveAs()).toBe(true);
    expect(backend.text("C:\\notes\\copy.md")).toBe("EDIT\n" + big.slice(0, loaded));
    expect(backend.text(A)).toBe("replaced by another program");
    expect(app.tab()).toMatchObject({
      path: "C:\\notes\\copy.md",
      dirty: false,
      fullyLoaded: true,
      externalChange: null,
      loadedOffset: 5 + loaded,
    });
    // The tab is now an ordinary, complete file: Save works again.
    app.type("!");
    expect(await app.actions.save()).toBe(true);
  });

  it("loads the whole file before writing it somewhere else", async () => {
    dialogs.saveAnswers.push("C:\\notes\\copy.md");
    expect(await app.actions.saveAs()).toBe(true);
    expect(backend.text("C:\\notes\\copy.md")).toBe(big);
  });

  it("loads a small file completely in the background", async () => {
    const small = line.repeat(4_000); // ~360 KB: more than the first chunk, under 2 MiB
    backend.write(B, small);
    await app.actions.openPaths([B]);
    await waitFor(() => app.tab().fullyLoaded);
    expect(app.text()).toBe(small);
  });
});

describe("closing tabs", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(A, "a");
    backend.write(B, "b");
    await app.actions.openPaths([A, B]);
    await app.actions.newTab();
  });

  it("closes a clean tab and activates its right neighbour", async () => {
    const a = app.tabByName("a.md");
    await app.actions.activate(a.id);
    expect(await app.actions.closeTab(a.id)).toBe(true);
    expect(app.state().tabs.map((t) => t.title)).toEqual(["b.txt", "Untitled"]);
    expect(app.tab().title).toBe("b.txt");
  });

  it("activates the left neighbour when the last tab closes", async () => {
    expect(await app.actions.closeTab(app.tab().id)).toBe(true);
    expect(app.tab().title).toBe("b.txt");
  });

  it("asks before closing a dirty tab; Cancel keeps it", async () => {
    const a = app.tabByName("a.md");
    await app.actions.activate(a.id);
    app.type("!");
    const closing = app.actions.closeTab(a.id);
    await app.answerClose("cancel");
    expect(await closing).toBe(false);
    expect(app.state().tabs).toHaveLength(3);
    expect(app.text(a.id)).toBe("a!");
  });

  it("Don't save closes without writing", async () => {
    const a = app.tabByName("a.md");
    await app.actions.activate(a.id);
    app.type("!");
    const closing = app.actions.closeTab(a.id);
    await app.answerClose("discard");
    expect(await closing).toBe(true);
    expect(app.state().tabs).toHaveLength(2);
    expect(backend.text(A)).toBe("a");
  });

  it("Save writes the file, then closes", async () => {
    const a = app.tabByName("a.md");
    await app.actions.activate(a.id);
    app.type("!");
    const closing = app.actions.closeTab(a.id);
    await app.answerClose("save");
    expect(await closing).toBe(true);
    expect(backend.text(A)).toBe("a!");
    expect(app.state().tabs).toHaveLength(2);
  });

  it("keeps the tab open when saving it fails", async () => {
    const a = app.tabByName("a.md");
    await app.actions.activate(a.id);
    app.type("!");
    backend.failNext.set("file_save", "disk full");
    const closing = app.actions.closeTab(a.id);
    await app.answerClose("save");
    expect(await closing).toBe(false);
    expect(app.state().tabs).toHaveLength(3);
  });

  // Regression for BUGS.md C4: an error message arriving over the "save
  // changes?" dialog replaced it without answering it, so the tab (and the
  // window) could never be closed again.
  it("can still close a tab after a message interrupted its save-changes dialog", async () => {
    const a = app.tabByName("a.md");
    await app.actions.activate(a.id);
    app.type("!");
    const closing = app.actions.closeTab(a.id);
    await waitFor(() => app.state().dialog?.kind === "confirm-close");
    app.store.showMessage("Something failed", "in the background");
    expect(await closing).toBe(false);
    expect(app.message()?.title).toBe("Something failed");
    app.actions.closeDialog();
    const again = app.actions.closeTab(a.id);
    await app.answerClose("discard");
    expect(await again).toBe(true);
  });

  it("closing a tab twice at once asks only once", async () => {
    const a = app.tabByName("a.md");
    await app.actions.activate(a.id);
    app.type("!");
    const first = app.actions.closeTab(a.id);
    const second = app.actions.closeTab(a.id);
    await app.answerClose("discard");
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(app.state().tabs).toHaveLength(2);
  });

  it("close others stops at the first Cancel", async () => {
    const a = app.tabByName("a.md");
    const b = app.tabByName("b.txt");
    await app.actions.activate(b.id);
    app.type("!");
    const closing = app.actions.closeOthers(a.id);
    await app.answerClose("cancel");
    await closing;
    expect(app.state().tabs.map((t) => t.title)).toEqual(["a.md", "b.txt", "Untitled"]);
  });

  it("close to the right closes only the tabs after the given one", async () => {
    await app.actions.closeToRight(app.tabByName("a.md").id);
    expect(app.state().tabs.map((t) => t.title)).toEqual(["a.md"]);
  });

  it("closing the only tab closes the window and leaves a fresh tab behind", async () => {
    app = await bootApp();
    const only = app.tab().id;
    await app.actions.closeTab(only);
    expect(fakeWindow.closes).toEqual([false]); // hidden to the background instead
    expect(app.state().tabs).toHaveLength(1);
    expect(app.tab().id).not.toBe(only);
  });
});

describe("tabs", () => {
  beforeEach(async () => {
    app = await bootApp();
    await app.actions.newTab();
    await app.actions.newTab();
  });

  it("cycles through tabs with wrap-around", async () => {
    const ids = app.state().tabs.map((t) => t.id);
    expect(app.state().activeId).toBe(ids[2]);
    await app.actions.nextTab(1);
    expect(app.state().activeId).toBe(ids[0]);
    await app.actions.nextTab(-1);
    expect(app.state().activeId).toBe(ids[2]);
  });

  it("reorders tabs", () => {
    const ids = app.state().tabs.map((t) => t.id);
    app.actions.moveTab(0, 2);
    expect(app.state().tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("names an untitled tab after its first line", async () => {
    app.type("- [ ] Buy milk and eggs\nsecond line");
    await waitFor(() => app.tab().title !== "Untitled");
    expect(app.tab().title).toBe("[ ] Buy milk and eggs");
  });

  it("toggles between formatted and syntax view, but never for plain text", () => {
    app.actions.toggleSyntax();
    expect(app.tab().mode).toBe("syntax");
    app.actions.toggleSyntax();
    expect(app.tab().mode).toBe("formatted");
    app.actions.setMode(app.tab().id, "plain");
    app.actions.toggleSyntax();
    expect(app.tab().mode).toBe("plain");
  });
});

describe("settings", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(A, "# a");
    backend.write(B, "b");
    await app.actions.openPaths([A, B]);
  });

  it("turning Formatting off makes markdown tabs plain and back again", () => {
    app.actions.setSetting("formatting", false);
    expect(app.tabByName("a.md").mode).toBe("plain");
    app.actions.setSetting("formatting", true);
    expect(app.tabByName("a.md").mode).toBe("formatted");
    expect(app.tabByName("b.txt").mode).toBe("plain");
  });

  it("zooms in steps and clamps to 10..500", () => {
    app.actions.zoomBy(10);
    expect(app.state().settings.zoom).toBe(110);
    app.actions.zoomBy(-1000);
    expect(app.state().settings.zoom).toBe(10);
    app.actions.zoomBy(10_000);
    expect(app.state().settings.zoom).toBe(500);
    app.actions.zoomReset();
    expect(app.state().settings.zoom).toBe(100);
  });

  it("turning recent files off clears the list", () => {
    expect(app.state().recent.length).toBe(2);
    app.actions.setSetting("recentFiles", false);
    expect(app.state().recent).toEqual([]);
  });

  it("persists settings to storage", async () => {
    app.actions.setSetting("wordWrap", false);
    app.store.flushPersistedPrefs();
    expect(JSON.parse(localStorage.getItem("notepadly.settings.v1")!).wordWrap).toBe(false);
  });

  it("tells the backend when automatic updates are switched", async () => {
    app.actions.setSetting("autoUpdate", false);
    await settle();
    expect(backend.calls.filter((c) => c.cmd === "update_configure").at(-1)?.args).toEqual({ enabled: false });
  });
});

describe("links in documents", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(A, "x");
    await app.actions.openPaths([A]);
  });

  it("opens web links in the browser", async () => {
    await import("./actions").then(({ editorHost }) => editorHost.openLink("https://example.com/a b"));
    await settle();
    expect(dialogs.openedUrls).toEqual(["https://example.com/a b"]);
  });

  it("opens a relative markdown link as a tab", async () => {
    backend.write("C:\\notes\\sub\\other note.md", "other");
    const { editorHost } = await import("./actions");
    editorHost.openLink("sub/other%20note.md");
    await waitFor(() => app.tab().title === "other note.md");
    expect(app.text()).toBe("other");
  });

  // BUGS.md M7: a linked PDF used to open as garbage in a text tab.
  it("opens a linked PDF with its default app instead of a tab", async () => {
    const { editorHost } = await import("./actions");
    editorHost.openLink("report.pdf");
    await settle();
    expect(dialogs.openedPaths).toEqual(["C:\\notes\\report.pdf"]);
    expect(app.state().tabs).toHaveLength(1);
  });

  it("never passes other URI schemes to the system", async () => {
    const { editorHost } = await import("./actions");
    editorHost.openLink("ms-settings:privacy");
    editorHost.openLink("javascript:alert(1)");
    await settle();
    expect(dialogs.openedUrls).toEqual([]);
    expect(app.state().tabs).toHaveLength(1);
  });

  it("writes links with spaces in angle brackets", () => {
    app.actions.applyLink("docs", "C:\\my docs\\a.md");
    expect(app.text()).toContain("[docs](<C:\\my docs\\a.md>)");
    app.actions.applyLink("", "https://x.y");
    expect(app.text()).toContain("[https://x.y](https://x.y)");
  });
});

describe("closing the window and restoring the session", () => {
  it("stores unsaved text as drafts without asking, and brings it back next launch", async () => {
    app = await bootApp();
    backend.write(A, "on disk");
    await app.actions.openPaths([A]);
    app.type(" + unsaved");
    await app.actions.newTab();
    app.type("untitled note");
    await waitFor(() => app.tab().title === "untitled note");
    await app.actions.closeWindow();
    expect(app.state().dialog).toBeNull();
    expect(fakeWindow.closes).toEqual([false]); // went to the background

    app = await bootApp({ keepDisk: true });
    expect(app.state().tabs.map((t) => t.title)).toEqual(["a.md", "untitled note"]);
    expect(app.tab()).toMatchObject({ title: "untitled note", dirty: true });
    expect(app.text()).toBe("untitled note");
    const a = app.tabByName("a.md");
    expect(a.dirty).toBe(true);
    await app.actions.activate(a.id);
    expect(app.text(a.id)).toBe("on disk + unsaved");
    // The file itself was never touched.
    expect(backend.text(A)).toBe("on disk");
  });

  it("restores clean file tabs lazily, reading the file only when activated", async () => {
    app = await bootApp();
    backend.write(A, "a");
    backend.write(B, "b");
    await app.actions.openPaths([A, B]);
    await app.actions.closeWindow();

    app = await bootApp({ keepDisk: true });
    const a = app.tabByName("a.md");
    expect(a.hibernated).toBe(true);
    expect(app.engine.hasDoc(a.id)).toBe(false);
    expect(backend.calls.filter((c) => c.cmd === "file_read_chunk").map((c) => c.args.path)).toEqual([B]);
    await app.actions.activate(a.id);
    expect(app.text(a.id)).toBe("a");
  });

  it("deletes the draft of a tab once it has been saved", async () => {
    app = await bootApp();
    backend.write(A, "a");
    await app.actions.openPaths([A]);
    app.type("!");
    await app.loader.flushPersistence();
    expect(backend.drafts.size).toBe(1);
    await app.actions.save();
    await app.loader.flushPersistence();
    expect(backend.drafts.size).toBe(0);
  });

  it("asks about every unsaved tab when the session is not kept", async () => {
    app = await bootApp({ settings: { startup: "new" } });
    app.type("draft");
    const closing = app.actions.closeWindow();
    await app.answerClose("discard");
    await closing;
    expect(backend.drafts.size).toBe(0);
    expect(JSON.parse(backend.session!).tabs).toEqual([]);
  });

  it("keeps the window open when that question is cancelled", async () => {
    app = await bootApp({ settings: { startup: "new" } });
    app.type("draft");
    const closing = app.actions.closeWindow();
    await app.answerClose("cancel");
    await closing;
    expect(fakeWindow.closes).toEqual([false]);
    expect(app.text()).toBe("draft");
  });

  it("asks instead of losing text when drafts cannot be written", async () => {
    app = await bootApp();
    app.type("precious");
    backend.failNext.set("draft_write", "disk full");
    const closing = app.actions.closeWindow();
    await app.answerClose("cancel");
    await closing;
    expect(app.text()).toBe("precious");
  });

  it("really closes the last window when background mode is off", async () => {
    app = await bootApp({ settings: { background: false } });
    await app.actions.closeWindow();
    expect(fakeWindow.closes).toEqual([true]);
  });

  it("starts a fresh session and discards old drafts when set to start new", async () => {
    app = await bootApp();
    app.type("old draft");
    await app.actions.closeWindow();
    expect(backend.drafts.size).toBe(1);

    app = await bootApp({ keepDisk: true, settings: { startup: "new" } });
    expect(app.state().tabs.map((t) => t.title)).toEqual(["Untitled"]);
    await waitFor(() => backend.drafts.size === 0 && JSON.parse(backend.session!).tabs.length === 0);
  });

  it("starts fresh when the session file is corrupt", async () => {
    backend.reset();
    backend.session = '{"tabs": [ {"id": 5}, broken';
    app = await bootApp({ keepDisk: true });
    expect(app.state().tabs).toHaveLength(1);
    expect(app.tab().title).toBe("Untitled");
  });

  it("only the main window restores and stores the session", async () => {
    backend.reset();
    backend.session = JSON.stringify({
      v: 1,
      activeId: "t1",
      tabs: [{ id: "t1", path: null, title: "x", dirty: false, mode: "plain" }],
    });
    app = await bootApp({ keepDisk: true, label: "window-1" });
    expect(app.tab().id).not.toBe("t1");
    app.type("second window text");
    await app.loader.flushPersistence();
    expect(backend.drafts.size).toBe(0);
  });

  // BUGS.md H16: a file deleted while the app was closed comes back as an
  // empty, unsaved tab; saving it writes an empty file.
  it.skip("H16: a restored tab whose file is gone is not an empty unsaved document", async () => {
    app = await bootApp();
    backend.write(A, "content");
    await app.actions.openPaths([A]);
    await app.actions.closeWindow();
    backend.delete(A);
    app = await bootApp({ keepDisk: true });
    expect(app.tab().dirty).toBe(false);
  });
});

describe("encodings and line endings", () => {
  const C = "C:\\notes\\c.txt";
  const cafeAnsi = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in windows-1252

  beforeEach(async () => {
    app = await bootApp();
  });

  // BUGS.md C6: characters the code page lacks silently became "?".
  it("C6: asks before saving characters ANSI cannot hold", async () => {
    backend.write(C, cafeAnsi);
    await app.actions.openPaths([C]);
    expect(app.tab()).toMatchObject({ encoding: "ansi" });
    expect(app.text()).toBe("café");
    app.type(" ш");

    // Cancel: nothing is written and the tab stays unsaved.
    expect(await app.actions.save()).toBe(false);
    expect(dialogs.messages[0].title).toBe("Some characters cannot be saved");
    expect(backend.bytes(C)).toEqual(cafeAnsi);
    expect(app.tab().dirty).toBe(true);

    // Keeping ANSI is still possible, but only when chosen.
    dialogs.messageAnswers.push("Save as ANSI");
    expect(await app.actions.save()).toBe(true);
    expect(backend.bytes(C)).toEqual(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x3f]));
  });

  it("C6: switches the file to UTF-8 when asked", async () => {
    backend.write(C, cafeAnsi);
    await app.actions.openPaths([C]);
    app.type(" ш");
    dialogs.messageAnswers.push("Save as UTF-8");
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(C)).toBe("café ш");
    expect(app.tab()).toMatchObject({ encoding: "utf-8", dirty: false });
  });

  // BUGS.md C7: only the first 256 KB decided the encoding.
  it("C7: reads a clean file again as ANSI when later bytes are not UTF-8", async () => {
    const head = "a\n".repeat(150_000); // 300 KB of ASCII: the first chunk looks like UTF-8
    backend.write(C, new Uint8Array([...new TextEncoder().encode(head), ...cafeAnsi]));
    await app.actions.openPaths([C]);
    await waitFor(() => app.tab().encoding === "ansi");
    await app.actions.ensureFullyLoaded(app.tab().id);
    expect(app.text()).toBe(head + "café");
    expect(app.tab().dirty).toBe(false);
  });

  // BUGS.md M15: a wrong encoding guess could not be corrected.
  it("M15: reopens a file with another encoding", async () => {
    backend.write(C, cafeAnsi);
    await app.actions.openPaths([C]);
    await app.actions.reopenWithEncoding("utf-8");
    expect(app.tab()).toMatchObject({ encoding: "utf-8", dirty: false });
    expect(app.text()).toBe("caf\uFFFD");
    await app.actions.reopenWithEncoding("ansi");
    expect(app.text()).toBe("café");
  });

  it("M15: asks before reopening throws away unsaved changes", async () => {
    backend.write(C, cafeAnsi);
    await app.actions.openPaths([C]);
    app.type("!");
    await app.actions.reopenWithEncoding("utf-8");
    expect(dialogs.messages[0].title).toBe("Reopen with encoding");
    expect(app.text()).toBe("café!");
    dialogs.messageAnswers.push("Reopen");
    await app.actions.reopenWithEncoding("utf-8");
    expect(app.text()).toBe("caf\uFFFD");
    expect(app.tab().dirty).toBe(false);
  });

  // BUGS.md H14: Rust keeps mixed line endings unless the user picked one.
  it("H14: asks Rust to normalise line endings only after one was picked", async () => {
    backend.write(C, "a\r\nb\nc");
    await app.actions.openPaths([C]);
    const saves = () =>
      backend.calls
        .filter((c) => c.cmd === "file_save")
        .map((c) => (c.args.req as { normalizeEol: boolean }).normalizeEol);
    app.type("!");
    await app.actions.save();
    await app.actions.setEol("LF");
    await app.actions.save();
    app.type("?");
    await app.actions.save();
    expect(saves()).toEqual([false, true, false]);
  });
});
