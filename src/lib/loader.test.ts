// @vitest-environment jsdom
// Chunked loading, background scans, hibernation and drafts: the loader against the fake backend.
import { bootApp, settle, waitFor, type App } from "../test/appHarness";
import { backend } from "../test/fakeTauri";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

const BIG = "C:\\data\\big.log";
const OTHER = "C:\\data\\other.txt";
const BIG2 = "C:\\data\\big2.log";
const line = "abcdefghij".repeat(9) + "\n"; // 91 bytes
const big = line.repeat(25_000); // ~2.3 MB, above the 2 MiB idle-load limit

let app: App;

describe("loading a big file in chunks", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(BIG, big);
    await app.actions.openPaths([BIG]);
  });

  it("counts the characters of the whole file in the background while partial", async () => {
    await waitFor(() => app.tab().tailChars !== null);
    expect(app.text().length + app.tab().tailChars!).toBe(big.length);
    expect(app.tab().fullyLoaded).toBe(false);
  });

  it("L5: the total of a partly loaded file includes the user's edits and later chunks", async () => {
    await waitFor(() => app.tab().tailChars !== null);
    const total = () => app.text().length + app.tab().tailChars!;
    app.type("12345");
    expect(total()).toBe(big.length + 5);
    const before = app.tab().loadedOffset;
    app.loader.onNearEnd(app.tab().id);
    await waitFor(() => app.tab().loadedOffset > before);
    expect(total()).toBe(big.length + 5);
  });

  it("L5: the total stays right after saving a partly loaded file", async () => {
    app.engine.restore(app.tab().id, { anchor: 0, head: 0, scrollTop: 0 });
    app.engine.insertText("EDIT\n");
    expect(await app.actions.save()).toBe(true);
    await waitFor(() => app.tab().tailChars !== null);
    expect(app.text().length + app.tab().tailChars!).toBe(big.length + 5);
  });

  it("loads one more chunk when the view nears the end", async () => {
    const before = app.tab().loadedOffset;
    app.loader.onNearEnd(app.tab().id);
    await waitFor(() => app.tab().loadedOffset > before);
    const after = app.tab().loadedOffset;
    expect(after - before).toBeLessThanOrEqual(1024 * 1024);
    expect(app.text()).toBe(big.slice(0, after));
    expect(app.tab().dirty).toBe(false);
  });

  it("never runs two chunk reads at once", async () => {
    const reads = () => backend.count("file_read_chunk");
    const start = reads();
    app.loader.onNearEnd(app.tab().id);
    app.loader.onNearEnd(app.tab().id);
    app.loader.onNearEnd(app.tab().id);
    await settle(10);
    expect(reads() - start).toBe(1);
  });

  it("keeps the user's edits when more chunks are appended", async () => {
    app.engine.restore(app.tab().id, { anchor: 0, head: 0, scrollTop: 0 });
    app.engine.insertText(">> ");
    await app.actions.ensureFullyLoaded(app.tab().id);
    expect(app.text()).toBe(">> " + big);
    expect(app.tab().dirty).toBe(true);
  });

  it("stops loading and keeps the text when the file changes under a dirty partial tab", async () => {
    app.type("edit");
    backend.write(BIG, "replaced");
    await expect(app.loader.ensureFullyLoaded(app.tab().id)).rejects.toThrow(/changed on disk/);
    expect(app.tab().externalChange).toBe("modified");
    expect(app.text().endsWith("edit")).toBe(true);
  });

  it("stops loading a clean partial tab when the file changes under it, and offers Reload", async () => {
    const shown = app.text();
    backend.write(BIG, "small now");
    app.loader.onNearEnd(app.tab().id);
    await waitFor(() => app.tab().externalChange === "modified");
    expect(app.text()).toBe(shown);
    await app.actions.reloadTab(app.tab().id);
    await waitFor(() => app.text() === "small now");
    expect(app.tab()).toMatchObject({ fullyLoaded: true, dirty: false, externalChange: null });
  });
});

describe("hibernating inactive tabs", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(BIG, big);
    backend.write(OTHER, "other");
    await app.actions.openPaths([BIG]);
    await app.actions.ensureFullyLoaded(app.tab().id);
    app.engine.restore(app.tab().id, { anchor: 1000, head: 1000, scrollTop: 0 });
    await app.actions.openPaths([OTHER]);
  });

  it("drops the editor state of a big clean tab that has been inactive for a minute", () => {
    const bigTab = app.tabByName("big.log");
    app.loader.hibernateSweep(Date.now() + 61_000);
    expect(app.engine.hasDoc(bigTab.id)).toBe(false);
    expect(app.tabByName("big.log").hibernated).toBe(true);
  });

  it("brings the text and cursor back when the tab is activated", async () => {
    const bigTab = app.tabByName("big.log");
    app.loader.hibernateSweep(Date.now() + 61_000);
    await app.actions.activate(bigTab.id);
    expect(app.engine.hasDoc(bigTab.id)).toBe(true);
    expect(app.text(bigTab.id).slice(0, 2000)).toBe(big.slice(0, 2000));
    expect(app.engine.snapshot(bigTab.id)).toMatchObject({ anchor: 1000, head: 1000 });
    expect(app.tabByName("big.log")).toMatchObject({ hibernated: false, dirty: false });
  });

  it("never hibernates a dirty, active, recent or small tab", async () => {
    const bigTab = app.tabByName("big.log");
    app.loader.hibernateSweep(Date.now() + 1_000);
    expect(app.engine.hasDoc(bigTab.id)).toBe(true);

    await app.actions.activate(bigTab.id);
    app.type("!");
    await app.actions.activate(app.tabByName("other.txt").id);
    app.loader.hibernateSweep(Date.now() + 61_000);
    expect(app.engine.hasDoc(bigTab.id)).toBe(true);
    // The active small tab stays too.
    expect(app.engine.hasDoc(app.tabByName("other.txt").id)).toBe(true);
  });

  // BUGS.md M12: hibernation wipes the undo history.
  it("M12: undo still works after a tab was hibernated and woken", async () => {
    const bigTab = app.tabByName("big.log");
    await app.actions.activate(bigTab.id);
    app.type("x");
    await app.actions.save();
    await app.actions.activate(app.tabByName("other.txt").id);
    app.loader.hibernateSweep(Date.now() + 61_000);
    await app.actions.activate(bigTab.id);
    app.engine.undo();
    expect(app.text(bigTab.id).endsWith("x")).toBe(false);
    expect(app.tabByName("big.log").dirty).toBe(true);
    app.engine.redo();
    expect(app.text(bigTab.id)).toBe(big + "x");
    expect(app.tabByName("big.log").dirty).toBe(false);
  });

  it("M12: keeps undo for a partly loaded tab", async () => {
    backend.write(BIG2, big);
    await app.actions.openPaths([BIG2]);
    const id = app.tab().id;
    app.loader.onNearEnd(id);
    await waitFor(() => app.tab(id).loadedOffset > 1024 * 1024);
    app.engine.restore(id, { anchor: 0, head: 0, scrollTop: 0 });
    app.engine.insertText("TOP\n");
    await app.actions.save();
    expect(app.tab(id).fullyLoaded).toBe(false);
    await app.actions.activate(app.tabByName("other.txt").id);
    app.loader.hibernateSweep(Date.now() + 61_000);
    expect(app.engine.hasDoc(id)).toBe(false);
    await app.actions.activate(id);
    expect(app.text(id).startsWith("TOP\n")).toBe(true);
    app.engine.undo();
    expect(app.text(id).startsWith("TOP")).toBe(false);
    expect(app.text(id)).toBe(big.slice(0, app.text(id).length));
  });

  it("M12: starts a fresh undo history when the file changed while the tab slept", async () => {
    const bigTab = app.tabByName("big.log");
    await app.actions.activate(bigTab.id);
    app.type("x");
    await app.actions.save();
    await app.actions.activate(app.tabByName("other.txt").id);
    app.loader.hibernateSweep(Date.now() + 61_000);
    backend.write(BIG, "rewritten");
    await app.loader.pollExternalChanges();
    await app.actions.activate(bigTab.id);
    expect(app.text(bigTab.id)).toBe("rewritten");
    app.engine.undo();
    expect(app.text(bigTab.id)).toBe("rewritten");
    expect(app.tabByName("big.log").dirty).toBe(false);
  });
});

describe("drafts", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  it("writes drafts only for tabs that changed since the last write", async () => {
    app.type("first");
    const first = app.tab().id;
    await app.actions.newTab();
    app.type("second");
    await app.loader.flushPersistence();
    expect([...backend.drafts.keys()].sort()).toEqual([first, app.tab().id].sort());

    const writes = () => backend.calls.filter((c) => c.cmd === "draft_write").map((c) => c.args.id);
    backend.calls = [];
    app.type(" more");
    await app.loader.flushPersistence();
    expect(writes()).toEqual([app.tab().id]);
    expect(backend.drafts.get(app.tab().id)).toBe("second more");
  });

  it("writes drafts after a typing pause without being asked", async () => {
    app.type("autosaved draft");
    await waitFor(() => backend.drafts.size === 1, 3000);
    expect([...backend.drafts.values()]).toEqual(["autosaved draft"]);
    expect(JSON.parse(backend.session!).tabs[0]).toMatchObject({ dirty: true, hasDraft: true });
  });

  it("H8: waits for a longer pause before writing the draft of a big document", async () => {
    expect(app.loader.draftDelay(1000)).toBe(800);
    expect(app.loader.draftDelay(10 * 1024 * 1024)).toBeGreaterThan(10_000);
    expect(app.loader.draftDelay(1e9)).toBe(30_000);

    app.type("x".repeat(1_600_000));
    await settle(1200);
    expect(backend.count("draft_write")).toBe(0);
    await waitFor(() => backend.drafts.size === 1, 6000);
    expect(backend.count("draft_write")).toBe(1);
  });

  it("retries a draft that failed to write on the next flush", async () => {
    app.type("text");
    backend.failNext.set("draft_write", "disk full");
    await expect(app.loader.flushPersistence()).rejects.toBe("disk full");
    expect(backend.drafts.size).toBe(0);
    await app.loader.flushPersistence();
    expect([...backend.drafts.values()]).toEqual(["text"]);
  });

  it("removes the draft when a tab is closed without saving", async () => {
    app.type("text");
    await app.loader.flushPersistence();
    await app.actions.newTab();
    const closing = app.actions.closeTab(app.state().tabs[0].id);
    await app.answerClose("discard");
    await closing;
    await settle();
    expect(backend.drafts.size).toBe(0);
  });

  it("restores a draft-backed tab even when its file was edited elsewhere meanwhile", async () => {
    backend.write(OTHER, "disk v1");
    await app.actions.openPaths([OTHER]);
    app.type(" + mine");
    await app.actions.closeWindow();
    backend.write(OTHER, "disk v2 by someone else");

    app = await bootApp({ keepDisk: true });
    const tab = app.tabByName("other.txt");
    await app.actions.activate(tab.id);
    expect(app.text(tab.id)).toBe("disk v1 + mine");
    expect(app.tabByName("other.txt").dirty).toBe(true);
    await app.loader.pollExternalChanges();
    expect(app.tabByName("other.txt").externalChange).toBe("modified");
  });

  it("M12: an unfolded callout stays unfolded after a restart and after a reload", async () => {
    const NOTE = "C:\\data\\note.md";
    const text = "intro\n\n> [!note]- Title\n> hidden body\n\nafter\n";
    const callout = text.indexOf("> [!note]");
    backend.write(NOTE, text);
    await app.actions.openPaths([NOTE]);
    const id = app.tab().id;
    expect(app.tab().mode).toBe("formatted");
    app.engine.restore(id, { anchor: 0, head: 0, scrollTop: 0, folds: [callout] });
    expect(app.engine.snapshot(id)?.folds).toEqual([callout]);
    // A reload after a change on disk keeps the fold state.
    backend.write(NOTE, text + "more\n");
    await app.loader.pollExternalChanges();
    await app.actions.reloadTab(id);
    await waitFor(() => app.text(id).endsWith("more\n"));
    expect(app.engine.snapshot(id)?.folds).toEqual([callout]);
    await app.actions.closeWindow();

    app = await bootApp({ keepDisk: true });
    const restored = app.tabByName("note.md");
    await app.actions.activate(restored.id);
    expect(app.engine.snapshot(restored.id)?.folds).toEqual([callout]);
  });

  it("falls back to the file on disk, clean, when a tab's draft has gone missing", async () => {
    backend.write(OTHER, "disk v1");
    await app.actions.openPaths([OTHER]);
    app.type(" + mine");
    await app.actions.closeWindow();
    backend.drafts.clear();

    app = await bootApp({ keepDisk: true });
    const tab = app.tabByName("other.txt");
    await app.actions.activate(tab.id);
    expect(app.text(tab.id)).toBe("disk v1");
    expect(app.tabByName("other.txt").dirty).toBe(false);
  });

  it("opens an empty, flagged tab and says so when a restored file cannot be read", async () => {
    backend.write(OTHER, "disk v1");
    backend.write(BIG, "active on restart");
    await app.actions.openPaths([OTHER]);
    await app.actions.openPaths([BIG]);
    await app.actions.closeWindow();

    app = await bootApp({ keepDisk: true });
    const tab = app.tabByName("other.txt");
    backend.failNext.set("file_read_chunk", "Access is denied. (os error 5)");
    await app.actions.activate(tab.id);
    expect(app.text(tab.id)).toBe("");
    expect(app.tabByName("other.txt").externalChange).toBe("modified");
    expect(app.message()).toMatchObject({ title: "Could not open file" });
    expect(app.message()?.body).toContain("Access is denied");
  });

  it("M22: text typed into a tab whose file could not be read is not saved over the file", async () => {
    backend.write(OTHER, "disk v1");
    backend.write(BIG, "active on restart");
    await app.actions.openPaths([OTHER]);
    await app.actions.openPaths([BIG]);
    await app.actions.closeWindow();

    app = await bootApp({ keepDisk: true });
    const tab = app.tabByName("other.txt");
    backend.failNext.set("file_read_chunk", "The process cannot access the file. (os error 32)");
    await app.actions.activate(tab.id);
    app.actions.closeDialog();
    app.type("typed ");
    expect(await app.actions.save()).toBe(false);
    expect(backend.text(OTHER)).toBe("disk v1");
    expect(app.message()?.body).toMatch(/could not be read/);
  });

  it("M22: a clean tab whose file could not be read loads it once it can be read", async () => {
    backend.write(OTHER, "disk v1");
    backend.write(BIG, "active on restart");
    await app.actions.openPaths([OTHER]);
    await app.actions.openPaths([BIG]);
    await app.actions.closeWindow();

    app = await bootApp({ keepDisk: true });
    const tab = app.tabByName("other.txt");
    backend.failNext.set("file_read_chunk", "The process cannot access the file. (os error 32)");
    await app.actions.activate(tab.id);
    await app.loader.pollExternalChanges();
    await waitFor(() => app.text(tab.id) === "disk v1");
    expect(app.tabByName("other.txt")).toMatchObject({ dirty: false, externalChange: null, fullyLoaded: true });
    // And it saves normally again.
    app.type(" + more");
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(OTHER)).toBe("disk v1 + more");
  });
});
