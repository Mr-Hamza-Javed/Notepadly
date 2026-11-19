// @vitest-environment jsdom
// File lifecycle edge cases found in the state review (BUGS.md STATE-*): tabs
// that have no editor state yet, moves between windows, and session writes.
import { bootApp, newFakeWindow, settle, waitFor, type App } from "../test/appHarness";
import { backend, dialogs, fakeWindow } from "../test/fakeTauri";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

const A = "C:\\notes\\a.md";
const B = "C:\\notes\\b.txt";

let app: App;

/** A restored session with A not yet loaded (no editor state) and B active. */
async function restoredWithLazyTab() {
  app = await bootApp();
  backend.write(A, "a text");
  backend.write(B, "b text");
  await app.actions.openPaths([A, B]);
  await app.actions.closeWindow();
  app = await bootApp({ keepDisk: true });
  const a = app.tabByName("a.md");
  expect(app.engine.hasDoc(a.id)).toBe(false);
  return a.id;
}

describe("STATE-1: a tab with no editor state whose file is deleted", () => {
  it("is not marked unsaved, since there is no text in it to save", async () => {
    const id = await restoredWithLazyTab();
    backend.delete(A);
    await app.loader.pollExternalChanges();
    expect(app.tab(id)).toMatchObject({ externalChange: "deleted", dirty: false });
  });

  it("closing it does not ask to save text that was never loaded", async () => {
    const id = await restoredWithLazyTab();
    backend.delete(A);
    await app.loader.pollExternalChanges();
    expect(await app.actions.closeTab(id)).toBe(true);
    expect(app.state().dialog).toBeNull();
    expect(app.state().tabs.map((t) => t.title)).toEqual(["b.txt"]);
  });

  it("a hibernated tab whose file is deleted stays clean too", async () => {
    app = await bootApp();
    backend.write(A, "x".repeat(1_500_000));
    backend.write(B, "b text");
    await app.actions.openPaths([A]);
    const id = app.tab().id;
    await app.actions.ensureFullyLoaded(id);
    await app.actions.openPaths([B]);
    app.loader.hibernateSweep(Date.now() + 120_000);
    expect(app.tab(id).hibernated).toBe(true);
    backend.delete(A);
    await app.loader.pollExternalChanges();
    expect(app.tab(id)).toMatchObject({ externalChange: "deleted", dirty: false });
  });

  it("is clean again when the file comes back", async () => {
    const id = await restoredWithLazyTab();
    backend.delete(A);
    await app.loader.pollExternalChanges();
    backend.write(A, "a text back");
    await app.loader.pollExternalChanges();
    expect(app.tab(id)).toMatchObject({ externalChange: null, dirty: false });
    await app.actions.activate(id);
    expect(app.text(id)).toBe("a text back");
  });
});

/** Holds every call of `cmd` until the returned release() is called. */
function holdCommand(cmd: string) {
  const original = backend.invoke.bind(backend);
  const held: (() => void)[] = [];
  const spy = vi.spyOn(backend, "invoke").mockImplementation(async (name, args) => {
    if (name === cmd) await new Promise<void>((resolve) => held.push(resolve));
    return original(name, args);
  });
  return {
    held: () => held.length,
    release() {
      spy.mockRestore();
      held.splice(0).forEach((resolve) => resolve());
    },
  };
}

describe("STATE-2: closing a window while its drafts are being written", () => {
  it("leaves no session and no draft behind once its tabs were discarded", async () => {
    backend.reset();
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("note");
    const hold = holdCommand("draft_write");
    const flushing = app.loader.flushPersistence();
    await waitFor(() => hold.held() === 1);
    backend.isLastWindow = false;
    const closing = app.actions.closeWindow();
    await app.answerClose("discard");
    await settle(20);
    hold.release();
    await flushing.catch(() => {});
    await closing;
    await settle(20);
    expect(fakeWindow.closes).toEqual([true]);
    expect(backend.windowSessions.size).toBe(0);
    expect(backend.drafts.size).toBe(0);
  });
});

describe("closing while a draft write hangs", () => {
  it("clears the session after a while instead of keeping the window open for good", async () => {
    backend.reset();
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("note");
    const hold = holdCommand("draft_write");
    void app.loader.flushPersistence().catch(() => {});
    await waitFor(() => hold.held() === 1);
    backend.isLastWindow = false;
    const closing = app.actions.closeWindow();
    await app.answerClose("discard");
    await closing;
    expect(fakeWindow.closes).toEqual([true]);
    expect(backend.windowSessions.size).toBe(0);
    // The write that hung returns at last: it must not store the session again.
    hold.release();
    await settle(20);
    expect(backend.windowSessions.size).toBe(0);
  });
});

describe("Save As after the dialog", () => {
  it("does nothing when the tab was closed while the dialog was open", async () => {
    app = await bootApp();
    app.type("draft text");
    const id = app.tab().id;
    await app.actions.newTab();
    let choose: (path: string) => void = () => {};
    // The native dialog answers late (a promise in the queue is awaited).
    (dialogs.saveAnswers as unknown[]).push(new Promise<string>((resolve) => (choose = resolve)));
    const saving = app.actions.saveAs(id);
    await settle(5);
    const closing = app.actions.closeTab(id);
    await app.answerClose("discard");
    await closing;
    choose("C:\\notes\\late.md");
    expect(await saving).toBe(false);
    expect(backend.exists("C:\\notes\\late.md")).toBe(false);
    expect(app.message()).toBeNull();
  });
});

describe("STATE-3: typing into a tab while it moves to another window", () => {
  it("cannot change the moving last tab, whose text has already been sent", async () => {
    backend.reset();
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("only tab");
    const moved = app.tab().id;
    backend.dropTarget = null;
    const moving = app.actions.moveTabOut(moved);
    await waitFor(() => backend.count("window_new") === 1);
    const sent = JSON.parse(backend.calls.find((c) => c.cmd === "window_new")!.args.transfer as string);
    // The new window takes a moment to start; keys typed meanwhile must not vanish.
    app.engine.insertText(" typed during the move");
    expect(app.text(moved)).toBe(sent.handoff.text);
    fakeWindow.deliver("tab-received", { id: moved });
    await moving;
    expect(fakeWindow.destroyed).toBe(true);
  });

  it("stays read-only when clicked again before the other window took it", async () => {
    backend.reset();
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("moving");
    const moved = app.tab().id;
    await app.actions.newTab();
    backend.dropTarget = { label: "main", x: 0, y: 0 };
    const moving = app.actions.moveTabOut(moved);
    await waitFor(() => fakeWindow.emitted.some((e) => e.event === "tab-incoming"));
    await app.actions.activate(moved);
    app.engine.insertText(" lost");
    expect(app.text(moved)).toBe("moving");
    fakeWindow.deliver("tab-received", { id: moved });
    await moving;
    expect(app.state().tabs.map((t) => t.id)).not.toContain(moved);
  });

  it("STATE-4: an untitled tab moved right after typing takes its name along", async () => {
    backend.reset();
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("Shopping list");
    const moved = app.tab().id;
    backend.dropTarget = null;
    const moving = app.actions.moveTabOut(moved);
    await waitFor(() => backend.count("window_new") === 1);
    const sent = JSON.parse(backend.calls.find((c) => c.cmd === "window_new")!.args.transfer as string);
    expect(sent.tab.title).toBe("Shopping list");
    fakeWindow.deliver("tab-received", { id: moved });
    await moving;
  });

  it("can be edited again when the move fails", async () => {
    backend.reset();
    app = await bootApp({ keepDisk: true, label: "window-1" });
    app.type("only tab");
    const moved = app.tab().id;
    backend.dropTarget = { label: "main", x: 0, y: 0 };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const moving = app.actions.moveTabOut(moved);
      await vi.advanceTimersByTimeAsync(11_000);
      await moving;
    } finally {
      vi.useRealTimers();
    }
    expect(app.state().activeId).toBe(moved);
    app.type("!");
    expect(app.text(moved)).toBe("only tab!");
  });
});

describe("STATE-9: saving a partly loaded file that was deleted", () => {
  const BIG = "C:\\data\\big.log";
  const big = "abcdefghij".repeat(9).concat("\n").repeat(30_000); // ~2.7 MB: loads in parts

  async function partialTab() {
    app = await bootApp();
    backend.write(BIG, big);
    await app.actions.openPaths([BIG]);
    expect(app.tab().fullyLoaded).toBe(false);
    app.engine.restore(app.tab().id, { anchor: 0, head: 0, scrollTop: 0 });
    app.engine.insertText("EDIT ");
  }

  it("says the file was deleted, not changed, once the poll has seen it", async () => {
    await partialTab();
    backend.delete(BIG);
    await app.loader.pollExternalChanges();
    expect(app.tab().externalChange).toBe("deleted");
    expect(await app.actions.save()).toBe(false);
    expect(app.tab().externalChange).toBe("deleted");
    expect(app.message()?.title).toBe("File deleted");
    expect(app.message()?.body).toMatch(/Save as/);
    expect(backend.exists(BIG)).toBe(false);
  });

  it("shows \"deleted\" at once when the save is what finds out, not \"changed\" first", async () => {
    await partialTab();
    backend.delete(BIG);
    expect(await app.actions.save()).toBe(false);
    expect(app.tab().externalChange).toBe("deleted");
    expect(app.message()?.title).toBe("File deleted");
  });

  it("a fully loaded file deleted before the poll saw it is simply written again", async () => {
    app = await bootApp();
    backend.write(A, "a text");
    await app.actions.openPaths([A]);
    app.type(" more");
    backend.delete(A);
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("a text more");
    expect(app.tab()).toMatchObject({ dirty: false, externalChange: null });
    expect(app.message()).toBeNull();
  });
});

describe("FILES-1: a file with mixed line endings", () => {
  const MIXED = "one\r\ntwo\nthree\r\n";

  it("picking the line ending already shown writes it on every line", async () => {
    app = await bootApp();
    backend.write(A, MIXED);
    await app.actions.openPaths([A]);
    expect(app.tab()).toMatchObject({ eol: "CRLF", mixedEol: true });
    await app.actions.setEol("CRLF");
    expect(app.tab()).toMatchObject({ dirty: true, mixedEol: false });
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("one\r\ntwo\r\nthree\r\n");
  });

  it("an edit without a pick keeps the other lines' endings (H14)", async () => {
    app = await bootApp();
    backend.write(A, MIXED);
    await app.actions.openPaths([A]);
    app.type("four");
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("one\r\ntwo\nthree\r\nfour");
    expect(app.tab().mixedEol).toBe(true);
  });

  it("a reload forgets a line ending picked before, with the rest of the edits", async () => {
    app = await bootApp();
    backend.write(A, MIXED);
    await app.actions.openPaths([A]);
    await app.actions.setEol("LF");
    await app.actions.reloadTab(app.tab().id);
    expect(app.tab()).toMatchObject({ dirty: false, eol: "CRLF", mixedEol: true });
    app.type("four");
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("one\r\ntwo\nthree\r\nfour");
  });

  it("the status bar says the line endings are mixed", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    app = await bootApp();
    backend.write(A, MIXED);
    await app.actions.openPaths([A]);
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { StatusBar } = await import("../components/StatusBar");
    const el = document.body.appendChild(document.createElement("div"));
    const root = createRoot(el);
    await act(async () => root.render(createElement(StatusBar)));
    const eol = () => el.querySelector<HTMLButtonElement>(".sb-eol button")!;
    expect(eol().textContent).toBe("Mixed");
    await act(async () => {
      await app.actions.setEol("CRLF");
    });
    expect(eol().textContent).toBe("Windows (CRLF)");
    await act(async () => root.unmount());
    el.remove();
  });
});

describe("a read-only file", () => {
  it("warns on the first edit, once, and Save says why it fails", async () => {
    app = await bootApp();
    backend.write(A, "locked");
    backend.readOnly.add(A);
    await app.actions.openPaths([A]);
    expect(app.tab().readOnly).toBe(true);
    expect(app.message()).toBeNull();
    app.type("!");
    expect(app.message()?.title).toBe("File is read-only");
    app.actions.closeDialog();
    app.type("!");
    expect(app.message()).toBeNull();
    expect(await app.actions.save()).toBe(false);
    expect(app.message()?.body).toMatch(/read-only\. Use Save as/);
    expect(backend.text(A)).toBe("locked");
  });

  it("a file that is not read-only says nothing", async () => {
    app = await bootApp();
    backend.write(A, "free");
    await app.actions.openPaths([A]);
    app.type("!");
    expect(app.message()).toBeNull();
    expect(app.tab().readOnly).toBe(false);
  });
});

describe("L16: a draft that cannot be read", () => {
  it("is kept, the user is told, and it comes back once it can be read", async () => {
    app = await bootApp();
    backend.write(A, "on disk");
    await app.actions.openPaths([A]);
    app.type(" + unsaved");
    const id = app.tab().id;
    await app.actions.closeWindow();
    backend.unreadableDrafts.add(id);
    app = await bootApp({ keepDisk: true });
    expect(app.message()?.title).toBe("Could not restore unsaved changes");
    expect(app.tab(id).dirty).toBe(true);
    expect(app.engine.hasDoc(id)).toBe(false);
    await app.loader.flushPersistence();
    await app.loader.pruneDrafts();
    expect(backend.drafts.get(id)).toBe("on disk + unsaved");
    expect(JSON.parse(backend.session!).tabs[0]).toMatchObject({ id, dirty: true, hasDraft: true });
    // Saving cannot write the file without its text.
    app.actions.closeDialog();
    expect(await app.actions.save(id)).toBe(false);
    expect(backend.text(A)).toBe("on disk");
    backend.unreadableDrafts.delete(id);
    app.actions.closeDialog();
    await app.actions.activate(id);
    expect(app.text(id)).toBe("on disk + unsaved");
    expect(app.tab(id).dirty).toBe(true);
  });
});

describe("what Rust reports about a file", () => {
  it("a file with NUL characters gets a warning that saving can damage it", async () => {
    app = await bootApp();
    backend.write(A, "MZ\u0000\u0001data");
    await app.actions.openPaths([A]);
    expect(app.message()?.title).toBe("File looks binary");
  });

  it("a save after an encoding change still keeps mixed line endings (originalEncoding)", async () => {
    app = await bootApp();
    backend.write(A, new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x62, 0x0a, 0x63])); // "café\r\nb\nc" in ANSI
    await app.actions.openPaths([A]);
    expect(app.tab()).toMatchObject({ encoding: "ansi", mixedEol: true });
    await app.actions.setEncoding("utf-8");
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("café\r\nb\nc");
    const req = backend.calls.filter((c) => c.cmd === "file_save").pop()!.args.req as { originalEncoding?: string };
    expect(req.originalEncoding).toBe("ansi");
  });

  it("MD-2: F5 uses the regional format Rust reports", async () => {
    app = await bootApp();
    backend.locale = "de-DE";
    app = await bootApp({ keepDisk: true });
    await settle(10);
    app.actions.insertDateTime();
    expect(app.text()).toMatch(/^\d{1,2}:\d{2} \d{1,2}\.\d{1,2}\.\d{4}$/);
  });
});

describe("typing right at start, before the session is restored", () => {
  it("keeps the text in a tab of its own next to the restored ones", async () => {
    app = await bootApp();
    backend.write(A, "a text");
    await app.actions.openPaths([A]);
    await app.actions.closeWindow();
    const original = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(async (cmd, args, caller) => {
      if (cmd === "window_sessions_read") {
        // The user types while the stored session is still being read.
        const { engine } = await import("../editor");
        engine.insertText("typed early");
      }
      return original(cmd, args, caller);
    });
    app = await bootApp({ keepDisk: true });
    await waitFor(() => app.state().tabs.length === 2 && app.state().tabs[1].title !== "Untitled");
    expect(app.state().tabs.map((t) => t.title)).toEqual(["a.md", "typed early"]);
    expect(app.text()).toBe("typed early");
    expect(app.tab()).toMatchObject({ dirty: true, path: null });
  });
});

describe("H8: drafts", () => {
  it("are not sent again when the text did not change since the last one", async () => {
    app = await bootApp();
    app.type("note");
    await app.loader.flushPersistence();
    expect(backend.count("draft_write")).toBe(1);
    // A tab switch or rename schedules a session write, but the text is the same.
    app.loader.markDraftChanged(app.tab().id);
    await app.loader.flushPersistence();
    expect(backend.count("draft_write")).toBe(1);
    app.type("!");
    await app.loader.flushPersistence();
    expect(backend.count("draft_write")).toBe(2);
    expect(backend.drafts.get(app.tab().id)).toBe("note!");
  });

  it("are not sent again for every chunk loaded into an edited big file, and still restore it whole", async () => {
    app = await bootApp();
    const big = `${"0123456789".repeat(9)}\n`.repeat(25_000); // ~2.3 MB, loaded in chunks
    backend.write(B, big);
    await app.actions.openPaths([B]);
    expect(app.tab().fullyLoaded).toBe(false);
    app.engine.restore(app.tab().id, { anchor: 0, head: 0, scrollTop: 0 });
    app.engine.insertText("EDIT\n");
    await app.loader.flushPersistence();
    expect(backend.count("draft_write")).toBe(1);
    await app.actions.ensureFullyLoaded(app.tab().id);
    await app.loader.flushPersistence();
    expect(backend.count("draft_write")).toBe(1);

    await app.actions.closeWindow();
    app = await bootApp({ keepDisk: true });
    const id = app.tabByName("b.txt").id;
    await app.actions.activate(id);
    await app.actions.ensureFullyLoaded(id);
    expect(app.text(id)).toBe(`EDIT\n${big}`);
    expect(app.tab(id).dirty).toBe(true);
  });
});

describe("MERGE-1: the start-up draft clean-up", () => {
  const untitled = (id: string) => ({
    id,
    path: null,
    title: id,
    dirty: true,
    mode: "plain",
    eol: "CRLF",
    encoding: "utf-8",
    stamp: null,
    loadedOffset: 0,
    fullyLoaded: true,
    hasDraft: true,
    snap: null,
  });

  it("keeps a draft another window writes while it runs, and runs before other windows open", async () => {
    backend.reset();
    backend.session = JSON.stringify({ v: 1, activeId: "mine", tabs: [untitled("mine")] });
    backend.windowSessions.set("wother", JSON.stringify({ v: 1, activeId: "theirs", tabs: [untitled("theirs")] }));
    backend.drafts.set("mine", "my text");
    backend.drafts.set("theirs", "their text");
    backend.drafts.set("orphan", "left by a crash");
    for (const id of ["mine", "theirs", "orphan"]) backend.draftTimes.set(id, 0);
    const original = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(async (cmd, args, caller) => {
      // A window of this run stores a brand-new tab's draft just as the clean-up starts.
      if (cmd === "drafts_prune") await original("draft_write", { id: "fresh", text: "new tab" }, "wother");
      return original(cmd, args, caller);
    });
    app = await bootApp({ keepDisk: true });
    await settle(20);
    expect(backend.drafts.get("fresh")).toBe("new tab");
    expect(backend.drafts.has("orphan")).toBe(false);
    expect(backend.drafts.get("mine")).toBe("my text");
    expect(backend.drafts.get("theirs")).toBe("their text");
    const order = backend.calls.map((c) => c.cmd);
    expect(order.indexOf("drafts_prune")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("drafts_prune")).toBeLessThan(order.indexOf("window_new"));
  });
});

// ---- Two windows over one backend ---------------------------------------------

/** Window "main" (the shared fakeWindow) and "window-1", running side by side. */
async function twoWindows(): Promise<{ a: App; b: App }> {
  backend.reset();
  // No background mode: the last window closes instead of hiding.
  const a = await bootApp({ keepDisk: true, settings: { background: false } });
  const b = await bootApp({ window: newFakeWindow(), label: "window-1" });
  return { a, b };
}

/** Runs `snapshot` when window `a` gets the move confirmation, before it reacts. */
function onReceipt(a: App, snapshot: () => void): void {
  const listener = a.win.listeners.get("tab-received")!;
  a.win.listeners.set("tab-received", (event) => {
    snapshot();
    listener(event);
  });
}

describe("STATE-5: a move the source gave up on", () => {
  it("leaves two independent copies, so closing one keeps the other's draft", async () => {
    const { a, b } = await twoWindows();
    app = a;
    await a.actions.newTab();
    a.type("precious");
    const moved = a.tab().id;
    await a.loader.flushPersistence();
    // The target is too slow: the source times out and keeps the tab.
    backend.dropTarget = { label: "window-slow", x: 0, y: 0 };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const moving = a.actions.moveTabOut(moved);
      await vi.advanceTimersByTimeAsync(11_000);
      await moving;
    } finally {
      vi.useRealTimers();
    }
    expect(a.state().tabs.map((t) => t.id)).toContain(moved);
    const sent = a.win.emitted.find((e) => e.event === "tab-incoming")!.payload as { transfer: unknown };
    // The other window takes it anyway, late.
    b.win.deliver("tab-incoming", { transfer: sent.transfer, x: 0, y: 0 });
    await waitFor(() => b.state().tabs.some((t) => t.title === "precious"));
    const copy = b.state().tabs.find((t) => t.title === "precious")!;
    await b.loader.flushPersistence();
    expect(copy.id).not.toBe(moved);
    // The source closes its copy without saving.
    const closing = a.actions.closeTab(moved);
    await a.answerClose("discard");
    expect(await closing).toBe(true);
    await settle(10);
    expect(backend.drafts.get(copy.id)).toBe("precious");
    const stored = JSON.parse(backend.windowSessions.get(b.loader.getSessionKey()!)!);
    expect(stored.tabs.find((t: { id: string }) => t.id === copy.id)).toMatchObject({ hasDraft: true, dirty: true });
  });
});

describe("STATE-7: a crash right after a move", () => {
  it("finds the tab stored in the target before it confirms, and gone from the source at once", async () => {
    const { a, b } = await twoWindows();
    app = a;
    await a.actions.newTab();
    a.type("moving text");
    const moved = a.tab().id;
    await a.actions.newTab();
    await a.loader.flushPersistence();
    backend.dropTarget = { label: "window-1", x: 0, y: 0 };
    let atReceipt: { session?: string; drafts: Map<string, string> } | null = null;
    onReceipt(a, () => {
      atReceipt = { session: backend.windowSessions.get(b.loader.getSessionKey()!), drafts: new Map(backend.drafts) };
    });
    await a.actions.moveTabOut(moved);
    const copy = b.state().tabs.find((t) => t.title === "moving text")!;
    expect(copy).toBeDefined();
    const seen = atReceipt as unknown as { session?: string; drafts: Map<string, string> };
    expect(seen.session).toBeDefined();
    const target = JSON.parse(seen.session!);
    expect(target.tabs.find((t: { id: string }) => t.id === copy.id)).toMatchObject({ hasDraft: true });
    expect(seen.drafts.get(copy.id)).toBe("moving text");
    // No timer has run since: the source's stored session is already without the tab.
    const source = JSON.parse(backend.session!);
    expect(source.tabs.map((t: { id: string }) => t.id)).not.toContain(moved);
  });
});

describe("F2: undo history moves with a dragged tab", () => {
  it("undoes edits made in the first window, back to clean at the saved point", async () => {
    const { a, b } = await twoWindows();
    app = a;
    backend.write("C:\\docs\\moved.txt", "saved text");
    await a.actions.openPaths(["C:\\docs\\moved.txt"]);
    const moved = a.tab().id;
    a.type(" plus edit");
    expect(a.tab().dirty).toBe(true);
    await a.actions.newTab();
    backend.dropTarget = { label: "window-1", x: 0, y: 0 };
    await a.actions.moveTabOut(moved);
    const copy = b.tabByName("moved.txt");
    expect(copy).toBeDefined();
    await b.actions.activate(copy.id);
    expect(b.text(copy.id)).toBe("saved text plus edit");
    expect(b.tab(copy.id).dirty).toBe(true);
    b.engine.undo();
    expect(b.text(copy.id)).toBe("saved text");
    expect(b.tab(copy.id).dirty).toBe(false);
    b.engine.redo();
    expect(b.text(copy.id)).toBe("saved text plus edit");
    expect(b.tab(copy.id).dirty).toBe(true);
    // Window-1 keeps running into the next test: no late draft writes from it.
    b.loader.setPersistence(false);
  });

  it("keeps the history of a hibernated tab for when it wakes in the other window", async () => {
    const { a, b } = await twoWindows();
    app = a;
    const big = "line of a big file\n".repeat(80_000);
    backend.write("C:\\docs\\big.log", big);
    await a.actions.openPaths(["C:\\docs\\big.log"]);
    const moved = a.tab().id;
    await a.actions.ensureFullyLoaded(moved);
    a.type("x");
    await a.actions.save();
    await a.actions.newTab();
    a.loader.hibernateSweep(Date.now() + 61_000);
    expect(a.tab(moved).hibernated).toBe(true);
    backend.dropTarget = { label: "window-1", x: 0, y: 0 };
    await a.actions.moveTabOut(moved);
    const copy = b.tabByName("big.log");
    await b.actions.activate(copy.id);
    await b.actions.ensureFullyLoaded(copy.id);
    expect(b.text(copy.id)).toBe(big + "x");
    b.engine.undo();
    expect(b.text(copy.id)).toBe(big);
    expect(b.tab(copy.id).dirty).toBe(true);
    // Window-1 keeps running into the next test: no late draft writes from it.
    b.loader.setPersistence(false);
  });
});

describe("STATE-8: closing two windows at once", () => {
  async function twoDirtyWindows() {
    const { a, b } = await twoWindows();
    app = a;
    a.type("unsaved in main");
    b.type("unsaved in window-1");
    return { a, b };
  }

  it("is an exit: neither window asks, and both keep their tabs as drafts", async () => {
    const { a, b } = await twoDirtyWindows();
    const closing = Promise.all([a.win.close(), b.win.close()]);
    await settle(600);
    expect(a.state().dialog).toBeNull();
    expect(b.state().dialog).toBeNull();
    await closing;
    expect(a.win.closes).toEqual([true]);
    expect(b.win.closes).toEqual([true]);
    expect(JSON.parse(backend.session!).tabs).toHaveLength(1);
    expect(JSON.parse(backend.windowSessions.get(b.loader.getSessionKey()!)!).tabs).toHaveLength(1);
    expect([...backend.drafts.values()].sort()).toEqual(["unsaved in main", "unsaved in window-1"]);
  });

  it("one window closed alone while the other stays still asks (WIN-2)", async () => {
    const { a, b } = await twoDirtyWindows();
    const closing = b.win.close();
    await b.answerClose("discard");
    await closing;
    expect(b.win.closes).toEqual([true]);
    expect(backend.windowSessions.has(b.loader.getSessionKey()!)).toBe(false);
    // The window left over is now the last one: it keeps its tab without asking.
    const last = a.win.close();
    await settle(50);
    expect(a.state().dialog).toBeNull();
    await last;
    expect(a.win.closes).toEqual([true]);
    expect(JSON.parse(backend.session!).tabs).toHaveLength(1);
  });

  it("a cancelled close counts the window as staying again", async () => {
    const { a, b } = await twoDirtyWindows();
    const closing = b.win.close();
    await b.answerClose("cancel");
    await closing;
    expect(b.win.closes).toEqual([false]);
    expect(backend.closingWindows.has("window-1")).toBe(false);
    // main is not the last window: it asks.
    const other = a.win.close();
    await a.answerClose("cancel");
    await other;
    expect(a.win.closes).toEqual([false]);
  });
});

describe("WIN-3: a file open in another window", () => {
  it("is shown in that window instead of opening a second copy", async () => {
    const { a, b } = await twoWindows();
    backend.write(A, "a text");
    backend.write(B, "b text");
    await a.actions.openPaths([A, B]);
    expect(a.tab().path).toBe(B);
    await settle(10);
    const focused = a.win.focused;
    await b.actions.openPaths([A]);
    expect(b.state().tabs.map((t) => t.path)).toEqual([null]);
    await waitFor(() => a.tab().path === A);
    expect(a.win.focused).toBeGreaterThan(focused);
  });

  it("is opened normally once that window closed its tab", async () => {
    const { a, b } = await twoWindows();
    backend.write(A, "a text");
    await a.actions.openPaths([A]);
    await a.actions.newTab();
    await a.actions.closeTab(a.state().tabs[0].id);
    await settle(10);
    await b.actions.openPaths([A]);
    expect(b.tab().path).toBe(A);
  });
});

describe("STATE-6: a moved tab keeps its runtime state", () => {
  it("a clean tab flagged deleted is clean again in the new window when the file comes back (H7)", async () => {
    const { a, b } = await twoWindows();
    app = a;
    backend.write(A, "a text");
    await a.actions.openPaths([A]);
    const moved = a.tab().id;
    await a.actions.newTab();
    backend.delete(A);
    await a.loader.pollExternalChanges();
    expect(a.tab(moved)).toMatchObject({ externalChange: "deleted", dirty: true });
    backend.dropTarget = { label: "window-1", x: 0, y: 0 };
    await a.actions.moveTabOut(moved);
    const copy = b.state().tabs.find((t) => t.path === A)!;
    expect(copy).toMatchObject({ externalChange: "deleted", dirty: true });
    backend.write(A, "a text");
    await b.loader.pollExternalChanges();
    expect(b.tab(copy.id).dirty).toBe(false);
  });

  it("the session stores a picked line ending, so a restart still applies it on save", async () => {
    app = await bootApp();
    backend.write(A, "one\r\ntwo\nthree\r\n");
    await app.actions.openPaths([A]);
    await app.actions.setEol("LF");
    await app.actions.closeWindow();
    app = await bootApp({ keepDisk: true });
    expect(app.tab().path).toBe(A);
    await app.actions.activate(app.tab().id);
    expect(await app.actions.save()).toBe(true);
    expect(backend.text(A)).toBe("one\ntwo\nthree\n");
  });
});
