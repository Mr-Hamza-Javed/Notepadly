// @vitest-environment jsdom
// Dialogs against the real app.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootApp, type App } from "../test/appHarness";
import { backend } from "../test/fakeTauri";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

const BIG = "C:\\data\\big.txt";
const SMALL = "C:\\data\\small.txt";

let app: App;
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  const r = root;
  if (r) await act(async () => r.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function renderDialogs(): Promise<HTMLElement> {
  const { Dialogs } = await import("./Dialogs");
  const el = document.body.appendChild(document.createElement("div"));
  host = el;
  const r = createRoot(el);
  root = r;
  await act(async () => r.render(createElement(Dialogs)));
  return el;
}

/** Makes every file read wait for `ms`, like a slow drive. */
function slowReads(ms: number): void {
  const invoke = backend.invoke.bind(backend);
  vi.spyOn(backend, "invoke").mockImplementation(async (cmd, args) => {
    if (cmd === "file_read_chunk") await new Promise((resolve) => setTimeout(resolve, ms));
    return invoke(cmd, args);
  });
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function bigPartialFile(): Promise<void> {
  backend.write(BIG, "line\n".repeat(700_000)); // 3.5 MB, loaded in parts
  await app.actions.openPaths([BIG]);
  expect(app.tab().fullyLoaded).toBe(false);
}

describe("Go to line in a file that is still loading", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  it("jumps once the file has loaded", async () => {
    await bigPartialFile();
    slowReads(20);
    const el = await renderDialogs();
    await act(async () => app.actions.showDialog({ kind: "goto" }));
    const input = el.querySelector<HTMLInputElement>("#goto-line")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "650000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Go to")!.click());
    for (let i = 0; i < 200 && app.state().dialog; i++) await wait(50);
    expect(app.state().dialog).toBeNull();
    expect(app.engine.snapshot(app.tab().id)?.head).toBe(5 * 649_999);
  });

  // BUGS.md UI-7: the late jump closed whatever dialog was open by then, in whatever tab was shown.
  it("does nothing when the dialog was cancelled before the file loaded", async () => {
    await bigPartialFile();
    const big = app.tab().id;
    backend.write(SMALL, "small");
    await app.actions.openPaths([SMALL]);
    await app.actions.activate(big);
    slowReads(20);
    const el = await renderDialogs();
    await act(async () => app.actions.showDialog({ kind: "goto" }));
    const input = el.querySelector<HTMLInputElement>("#goto-line")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "650000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Go to")!.click());
    expect(app.store.getTab(big)!.fullyLoaded).toBe(false);
    // Changed their mind: Escape, then Ctrl+K for the Link dialog.
    await act(async () => app.actions.closeDialog());
    await act(async () => app.actions.showDialog({ kind: "link", initialText: "", initialUrl: "" }));
    for (let i = 0; i < 200 && !app.store.getTab(big)!.fullyLoaded; i++) await wait(50);
    await wait(100);
    expect(app.state().dialog?.kind).toBe("link");
    expect(app.engine.snapshot(big)?.head).toBe(0);
  });
});
