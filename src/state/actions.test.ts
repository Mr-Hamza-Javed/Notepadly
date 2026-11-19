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
    app.type("a note");
    await app.actions.openPaths([A, B]);
    const call = backend.calls.find((c) => c.cmd === "window_new");
    expect(call?.args).toEqual({ paths: [A, B] });
    expect(app.state().tabs).toHaveLength(1);
  });

  it("M10: an empty window takes the file instead of opening another window", async () => {
    app = await bootApp({ settings: { openFilesIn: "window" } });
    backend.write(A, "a");
    await app.actions.openPaths([A]);
    expect(backend.count("window_new")).toBe(0);
    expect(app.state().tabs.map((t) => t.title)).toEqual(["a.md"]);
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
  it("H7: a deleted-then-restored file leaves an unedited tab clean", async () => {
    backend.delete(A);
    await app.loader.pollExternalChanges();
    backend.write(A, "original");
    await app.loader.pollExternalChanges();
    await settle(20);
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
  });

  it("H7: a clean tab whose file comes back with new content reloads it", async () => {
    backend.delete(A);
    await app.loader.pollExternalChanges();
    backend.write(A, "checked out");
    await app.loader.pollExternalChanges();
    await waitFor(() => app.text() === "checked out");
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
  });

  it("H7: text typed while the file was gone stays unsaved when it comes back", async () => {
    backend.delete(A);
    await app.loader.pollExternalChanges();
    app.type(" mine");
    backend.write(A, "original");
    await app.loader.pollExternalChanges();
    await settle(20);
    expect(app.tab().dirty).toBe(true);
    expect(app.text()).toBe("original mine");
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

  it("C8: typing while a tab loads never goes into the previous tab", async () => {
    backend.write(A, "AAA file");
    backend.write(B, "BBB file");
    await app.actions.openPaths([A, B]);
    const a = app.tabByName("a.md");
    expect(app.engine.hasDoc(a.id)).toBe(false);
    const switching = app.actions.activate(a.id);
    app.engine.insertText("TYPED");
    await switching;
    expect(app.text(app.tabByName("b.txt").id)).toBe("BBB file");
    expect(app.tabByName("b.txt").dirty).toBe(false);
    expect(app.text(a.id)).toBe("AAA file");
    expect(app.tabByName("a.md").dirty).toBe(false);
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

  it("M19: Formatting off and on again keeps each tab's Markdown syntax choice", async () => {
    await app.actions.activate(app.tabByName("a.md").id);
    app.actions.toggleSyntax();
    expect(app.tabByName("a.md").mode).toBe("syntax");
    app.actions.setSetting("formatting", false);
    expect(app.tabByName("a.md").mode).toBe("plain");
    app.actions.setSetting("formatting", true);
    expect(app.tabByName("a.md").mode).toBe("syntax");
  });

  it("M19: a .txt file can be shown formatted from the status bar and back to plain", async () => {
    await app.actions.activate(app.tabByName("b.txt").id);
    const modes = [app.tab().mode];
    for (let i = 0; i < 3; i++) {
      app.actions.nextMode();
      modes.push(app.tab().mode);
    }
    expect(modes).toEqual(["plain", "formatted", "syntax", "plain"]);
    await app.actions.activate(app.tabByName("a.md").id);
    app.actions.nextMode();
    app.actions.nextMode();
    expect(app.tab().mode).toBe("formatted");
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

  it("H12: a setting changed in another window takes effect in this one", async () => {
    const setConfig = vi.spyOn(app.engine, "setConfig");
    const settings = { ...app.state().settings, formatting: false, wordWrap: false };
    localStorage.setItem("notepadly.settings.v1", JSON.stringify(settings));
    window.dispatchEvent(new StorageEvent("storage", { key: "notepadly.settings.v1" }));
    expect(app.state().settings).toMatchObject({ formatting: false, wordWrap: false });
    expect(app.tabByName("a.md").mode).toBe("plain");
    expect(setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ wordWrap: false }));
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

  it("T2: an untitled tab closed right after typing comes back with its name", async () => {
    app = await bootApp();
    app.type("Shopping list");
    await app.actions.closeWindow();

    app = await bootApp({ keepDisk: true });
    expect(app.tab().title).toBe("Shopping list");
    expect(app.text()).toBe("Shopping list");
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

  it("L16: deletes drafts that no restored tab owns", async () => {
    app = await bootApp();
    app.type("kept draft");
    await app.actions.closeWindow();
    const kept = [...backend.drafts.keys()];
    backend.drafts.set("orphan-from-a-crash", "lost text");

    app = await bootApp({ keepDisk: true });
    await waitFor(() => !backend.drafts.has("orphan-from-a-crash"));
    expect([...backend.drafts.keys()]).toEqual(kept);
    expect(app.text()).toBe("kept draft");
  });

  it("L16: a corrupt session leaves no drafts behind", async () => {
    backend.reset();
    backend.session = "not json";
    backend.drafts.set("t-old", "orphaned");
    app = await bootApp({ keepDisk: true });
    await waitFor(() => backend.drafts.size === 0);
  });

  it("starts fresh when the session file is corrupt", async () => {
    backend.reset();
    backend.session = '{"tabs": [ {"id": 5}, broken';
    app = await bootApp({ keepDisk: true });
    expect(app.state().tabs).toHaveLength(1);
    expect(app.tab().title).toBe("Untitled");
  });

  it("a new window does not take the main window's session, but stores its own (M18)", async () => {
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
    expect([...backend.drafts.values()]).toEqual(["second window text"]);
    const [stored] = [...backend.windowSessions.values()];
    expect(JSON.parse(stored).tabs[0]).toMatchObject({ id: app.tab().id, dirty: true, hasDraft: true });
    // The main window's session is untouched.
    expect(JSON.parse(backend.session!).tabs[0].id).toBe("t1");
  });

  // BUGS.md H16: a file deleted while the app was closed comes back as an
  // empty, unsaved tab; saving it writes an empty file.
  it("H16: a restored tab whose file is gone is not an empty unsaved document", async () => {
    app = await bootApp();
    backend.write(A, "content");
    await app.actions.openPaths([A]);
    await app.actions.closeWindow();
    backend.delete(A);
    app = await bootApp({ keepDisk: true });
    expect(app.tab().dirty).toBe(false);
    expect(app.tab().externalChange).toBe("deleted");
    // Saving the empty tab does not create an empty file.
    expect(await app.actions.save()).toBe(true);
    expect(backend.exists(A)).toBe(false);
    // When the file comes back, the tab shows it.
    backend.write(A, "content again");
    await app.loader.pollExternalChanges();
    await waitFor(() => app.text() === "content again");
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
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

describe("several windows", () => {
  /** Runs one window, leaves its text as a draft and closes it as the last window. */
  async function windowWithDraft(label: string, text: string) {
    app = await bootApp({ keepDisk: true, label });
    app.type(text);
    await waitFor(() => app.tab().title === text);
    await app.actions.closeWindow();
    return app.loader.getSessionKey();
  }

  it("C5: a window that was not the main one still brings its unsaved text back", async () => {
    backend.reset();
    const key = await windowWithDraft("window-1", "from the second window");
    expect(key).not.toBeNull();
    // Next start: the first window takes that window's session.
    app = await bootApp({ keepDisk: true });
    expect(app.tab()).toMatchObject({ title: "from the second window", dirty: true });
    expect(app.text()).toBe("from the second window");
    expect(app.loader.getSessionKey()).toBe(key);
  });

  it("restores every window that was open: one here, a new window for each other one", async () => {
    backend.reset();
    await windowWithDraft("main", "first");
    const second = await windowWithDraft("window-1", "second");
    app = await bootApp({ keepDisk: true });
    expect(app.text()).toBe("first");
    const opened = backend.calls.filter((c) => c.cmd === "window_new").map((c) => c.args);
    expect(opened).toEqual([{ paths: [], restore: second }]);

    // That window boots and takes exactly that session.
    backend.boot = { restore: second, transfer: null };
    app = await bootApp({ keepDisk: true, label: "window-1" });
    expect(app.text()).toBe("second");
    expect(app.loader.getSessionKey()).toBe(second);
  });

  it("L16 with several windows: the first window's draft clean-up keeps the drafts of the other stored sessions", async () => {
    backend.reset();
    await windowWithDraft("main", "first");
    await windowWithDraft("window-1", "second");
    backend.drafts.set("orphan-from-a-crash", "lost text");
    app = await bootApp({ keepDisk: true });
    await waitFor(() => !backend.drafts.has("orphan-from-a-crash"));
    // The second window has not booted yet; its draft must still be there for it.
    expect([...backend.drafts.values()].sort()).toEqual(["first", "second"]);
  });

  it("a window closed while others stay open asks about its unsaved tabs and leaves no session", async () => {
    backend.reset();
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("note");
    await app.loader.flushPersistence();
    expect(backend.windowSessions.size).toBe(1);
    backend.isLastWindow = false;
    const closing = app.actions.closeWindow();
    await app.answerClose("discard");
    await closing;
    expect(fakeWindow.closes).toEqual([true]);
    expect(backend.windowSessions.size).toBe(0);
    expect(backend.drafts.size).toBe(0);
  });

  it("start new session discards every window's session", async () => {
    backend.reset();
    await windowWithDraft("window-1", "old");
    app = await bootApp({ keepDisk: true, settings: { startup: "new" } });
    await waitFor(() => backend.windowSessions.size === 0 && backend.drafts.size === 0);
    expect(app.tab().title).toBe("Untitled");
  });

  it("M17: Exit closes every window for good and keeps their sessions", async () => {
    app = await bootApp();
    app.type("kept");
    await app.actions.exit();
    expect(fakeWindow.emitted).toContainEqual({ target: "*", event: "exit-app", payload: { from: "main" } });
    expect(fakeWindow.destroyed).toBe(true);
    expect(fakeWindow.closes).toEqual([]); // not hidden in the background
    expect([...backend.drafts.values()]).toEqual(["kept"]);
  });

  it("M17: another window's Exit closes this one too, storing its tabs", async () => {
    app = await bootApp({ label: "window-1" });
    app.type("mine");
    backend.isLastWindow = false;
    fakeWindow.deliver("exit-app", { from: "main" });
    await waitFor(() => fakeWindow.destroyed);
    expect(app.state().dialog).toBeNull();
    expect([...backend.drafts.values()]).toEqual(["mine"]);
    expect(backend.windowSessions.size).toBe(1);
  });

  it("M9: listens for files from a second launch before taking its start-up files", async () => {
    app = await bootApp();
    const taken = backend.calls.findIndex((c) => c.cmd === "take_pending_paths");
    expect(taken).toBeGreaterThanOrEqual(0);
    expect(fakeWindow.listenedAt.get("open-paths")).toBeLessThanOrEqual(taken);
    expect(fakeWindow.listenedAt.get("open-paths-here")).toBeLessThanOrEqual(taken);
  });

  it("files from a second launch open in this window and bring it forward", async () => {
    app = await bootApp();
    backend.write(A, "a");
    fakeWindow.deliver("open-paths", [A]);
    await waitFor(() => app.tab().title === "a.md");
    await waitFor(() => fakeWindow.focused > 0);
  });

  it("files from a second launch go to a new window when that setting is on and this one is in use", async () => {
    app = await bootApp({ settings: { openFilesIn: "window" } });
    app.type("busy");
    backend.write(A, "a");
    fakeWindow.deliver("open-paths", [A]);
    await waitFor(() => backend.count("window_new") === 1);
    expect(app.state().tabs).toHaveLength(1);
  });

  it("M11: a new file name on the command line asks to create the file", async () => {
    backend.reset();
    backend.mkdir("C:\\notes");
    backend.pendingPaths = ["C:\\notes\\new.txt", "C:\\notes\\no.txt"];
    app = await bootApp({ keepDisk: true, askAnswers: [true, false] });
    expect(dialogs.asked).toHaveLength(2);
    expect(dialogs.asked[0]).toContain("new.txt");
    expect(backend.exists("C:\\notes\\new.txt")).toBe(true);
    expect(backend.exists("C:\\notes\\no.txt")).toBe(false);
    expect(app.state().tabs.map((t) => t.title)).toEqual(["new.txt"]);
    expect(app.state().dialog).toBeNull();
  });
});

describe("moving tabs between windows (F2)", () => {
  type Transfer = import("./actions").TabTransfer;

  /** Source window with an unsaved file tab and an untitled one; returns what it sent. */
  async function sendDirtyTab(target: { label: string; x: number; y: number } | null) {
    backend.reset();
    backend.write(A, "on disk");
    app = await bootApp({ keepDisk: true });
    await app.actions.openPaths([A]);
    app.type(" + unsaved");
    const moved = app.tab().id;
    await app.actions.newTab();
    app.type("stays");
    await waitFor(() => app.tab().title === "stays");
    await app.loader.flushPersistence();
    expect(backend.drafts.has(moved)).toBe(true);
    backend.dropTarget = target;
    const moving = app.actions.moveTabOut(moved);
    let transfer: Transfer | undefined;
    await waitFor(() => {
      const sent = fakeWindow.emitted.find((e) => e.event === "tab-incoming");
      const opened = backend.calls.find((c) => c.cmd === "window_new");
      if (sent) transfer = (sent.payload as { transfer: Transfer }).transfer;
      else if (opened) transfer = JSON.parse(opened.args.transfer as string);
      return !!transfer;
    });
    return { moving, moved, transfer: transfer! };
  }

  it("moves an unsaved tab onto another window and keeps its text and draft", async () => {
    const { moving, moved, transfer } = await sendDirtyTab({ label: "window-1", x: 10, y: 400 });
    expect(transfer).toMatchObject({ from: "main", tab: { id: moved, path: A, dirty: true } });
    expect(transfer.handoff.text).toBe("on disk + unsaved");
    // Not removed until the other window confirms.
    expect(app.state().tabs).toHaveLength(2);
    fakeWindow.deliver("tab-received", { id: moved });
    await moving;
    expect(app.state().tabs.map((t) => t.title)).toEqual(["stays"]);
    await app.loader.flushPersistence();
    // The other window stored its own copy under a new id before it answered (STATE-5).
    expect(backend.drafts.has(moved)).toBe(false);
    expect(JSON.parse(backend.session!).tabs.map((t: { id: string }) => t.id)).not.toContain(moved);

    // The other window takes it.
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("x");
    fakeWindow.deliver("tab-incoming", { transfer, x: 10, y: 400 });
    await waitFor(() => app.state().tabs.length === 2 && app.state().activeId === app.state().tabs[1].id);
    const taken = app.state().tabs[1].id;
    expect(taken).not.toBe(moved);
    expect(app.tab()).toMatchObject({ dirty: true, path: A });
    expect(app.text()).toBe("on disk + unsaved");
    expect(fakeWindow.emitted).toContainEqual({ target: "main", event: "tab-received", payload: { id: moved } });
    // Stored before the answer (STATE-7).
    const stored = JSON.parse([...backend.windowSessions.values()][0]);
    expect(stored.tabs.find((t: { id: string }) => t.id === taken)).toMatchObject({ dirty: true, hasDraft: true });
    expect(backend.drafts.get(taken)).toBe("on disk + unsaved");
    // Nothing was written to the file, and it saves normally from here.
    expect(backend.text(A)).toBe("on disk");
    await app.actions.save();
    expect(backend.text(A)).toBe("on disk + unsaved");
    expect(app.tab().dirty).toBe(false);
  });

  it("dropped outside every window, the tab opens in a new window under the mouse", async () => {
    const { moving, moved, transfer } = await sendDirtyTab(null);
    const call = backend.calls.find((c) => c.cmd === "window_new")!;
    expect(call.args).toMatchObject({ paths: [], atCursor: true });
    fakeWindow.deliver("tab-received", { id: moved });
    await moving;

    backend.boot = { restore: null, transfer: JSON.stringify(transfer) };
    app = await bootApp({ keepDisk: true, label: "window-2" });
    // It replaced the empty tab a new window starts with.
    expect(app.state().tabs.map((t) => t.title)).toEqual(["a.md"]);
    expect(app.text()).toBe("on disk + unsaved");
    expect(app.tab().dirty).toBe(true);
  });

  it("keeps the tab when the other window never answers", async () => {
    const { moving } = await sendDirtyTab({ label: "window-1", x: 0, y: 0 });
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(11_000);
    } finally {
      vi.useRealTimers();
    }
    await moving;
    expect(app.state().tabs).toHaveLength(2);
    expect(app.message()?.title).toBe("Could not move the tab");
  });

  it("moving the last tab closes its window instead of leaving it empty", async () => {
    backend.reset();
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("only tab");
    const moved = app.tab().id;
    backend.dropTarget = { label: "main", x: 0, y: 0 };
    const moving = app.actions.moveTabOut(moved);
    await waitFor(() => fakeWindow.emitted.some((e) => e.event === "tab-incoming"));
    fakeWindow.deliver("tab-received", { id: moved });
    await moving;
    expect(fakeWindow.destroyed).toBe(true);
    expect(backend.windowSessions.size).toBe(0);
  });

  it("a partly loaded file moves without being read again from the start", async () => {
    backend.reset();
    const big = "line\n".repeat(600_000); // 3 MB: only the first chunk loads at once
    backend.write(B, big);
    app = await bootApp({ keepDisk: true });
    await app.actions.openPaths([B]);
    const partial = app.tab();
    expect(partial.fullyLoaded).toBe(false);
    const transfer = { from: "main", tab: partial, handoff: app.loader.handOff(partial.id) };
    app = await bootApp({ keepDisk: true, label: "window-1" });
    backend.calls = [];
    fakeWindow.deliver("tab-incoming", { transfer, x: 0, y: 0 });
    await waitFor(() => app.tab().path === B);
    expect(app.text()).toBe(transfer.handoff.text);
    expect(app.tab()).toMatchObject({ loadedOffset: partial.loadedOffset, fullyLoaded: false, dirty: false });
    // The rest still loads from where the other window stopped.
    await app.actions.ensureFullyLoaded(app.tab().id);
    expect(app.text()).toBe(big);
    const reads = backend.calls.filter((c) => c.cmd === "file_read_chunk").map((c) => c.args.offset as number);
    expect(Math.min(...reads)).toBe(partial.loadedOffset);
  });
});
