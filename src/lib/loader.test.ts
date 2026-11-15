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
    await waitFor(() => app.tab().totalChars !== null);
    expect(app.tab().totalChars).toBe(big.length);
    expect(app.tab().fullyLoaded).toBe(false);
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

  it("reloads a clean partial tab when the file changes under it", async () => {
    backend.write(BIG, "small now");
    app.loader.onNearEnd(app.tab().id);
    await waitFor(() => app.text() === "small now");
    expect(app.tab()).toMatchObject({ fullyLoaded: true, dirty: false });
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
  it.skip("M12: undo still works after a tab was hibernated and woken", async () => {
    const bigTab = app.tabByName("big.log");
    await app.actions.activate(bigTab.id);
    app.type("x");
    await app.actions.save();
    await app.actions.activate(app.tabByName("other.txt").id);
    app.loader.hibernateSweep(Date.now() + 61_000);
    await app.actions.activate(bigTab.id);
    app.engine.undo();
    expect(app.text(bigTab.id).endsWith("x")).toBe(false);
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
});
