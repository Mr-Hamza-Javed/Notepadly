// @vitest-environment jsdom
// File lifecycle edge cases found in the state review (BUGS.md STATE-*): tabs
// that have no editor state yet, moves between windows, and session writes.
import { bootApp, settle, waitFor, type App } from "../test/appHarness";
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
