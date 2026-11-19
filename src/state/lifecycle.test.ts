// @vitest-environment jsdom
// File lifecycle edge cases found in the state review (BUGS.md STATE-*): tabs
// that have no editor state yet, moves between windows, and session writes.
import { bootApp, newFakeWindow, settle, waitFor, type App } from "../test/appHarness";
import { backend, fakeWindow } from "../test/fakeTauri";
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

// ---- Two windows over one backend ---------------------------------------------

/** Window "main" (the shared fakeWindow) and "window-1", running side by side. */
async function twoWindows(): Promise<{ a: App; b: App }> {
  backend.reset();
  const a = await bootApp({ keepDisk: true });
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
