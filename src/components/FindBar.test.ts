// @vitest-environment jsdom
// The find bar against the real app: replacing in a big file and moving between tabs.
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

const BIG = "C:\\data\\big.txt";
const A = "C:\\data\\a.txt";
const B = "C:\\data\\b.txt";

let app: App;
let root: Root | null = null;
let host: HTMLElement | null = null;

async function renderFindBar(): Promise<HTMLElement> {
  // Imported after bootApp, which resets the modules, so the bar talks to this app.
  const { FindBar } = await import("./FindBar");
  const el = document.createElement("div");
  document.body.appendChild(el);
  host = el;
  const r = createRoot(el);
  root = r;
  await act(async () => r.render(createElement(FindBar)));
  return el;
}

const field = (el: HTMLElement, label: string) => el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text)!;
const count = (el: HTMLElement) => el.querySelector(".find-count")?.textContent ?? "";

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Makes every file read wait for `ms`, like a slow drive. */
function slowReads(ms: number): void {
  const invoke = backend.invoke.bind(backend);
  vi.spyOn(backend, "invoke").mockImplementation(async (cmd, args) => {
    if (cmd === "file_read_chunk") await new Promise((resolve) => setTimeout(resolve, ms));
    return invoke(cmd, args);
  });
}

/** Lets debounces, loads and effects run. */
const flushUi = (ms = 200) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

afterEach(async () => {
  const r = root;
  if (r) await act(async () => r.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("find bar", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  it("C2: Replace all in a file that is still loading replaces every match in the file", async () => {
    const text = "foo bar\n".repeat(400_000); // 3.2 MB, loaded in chunks
    backend.write(BIG, text);
    await app.actions.openPaths([BIG]);
    expect(app.tab().fullyLoaded).toBe(false);
    slowReads(100);
    app.actions.openFind(true);
    const el = await renderFindBar();
    await typeInto(field(el, "Find"), "foo");
    await typeInto(field(el, "Replace"), "baz");
    expect(app.tab().fullyLoaded).toBe(false);
    // The button waits for the whole file; click as soon as it can be clicked.
    for (let i = 0; i < 100 && button(el, "Replace all").disabled; i++) await flushUi(100);
    await act(async () => button(el, "Replace all").click());
    for (let i = 0; i < 100 && !(app.tab().fullyLoaded && !app.text().includes("foo")); i++) await flushUi(100);
    expect(app.text()).toBe("baz bar\n".repeat(400_000));
  });

  it("M14: Replace all in a big file shows Replacing… and can be cancelled", async () => {
    const text = "foo bar\n".repeat(400_000);
    backend.write(BIG, text);
    await app.actions.openPaths([BIG]);
    await app.actions.ensureFullyLoaded(app.tab().id);
    app.actions.openFind(true);
    const el = await renderFindBar();
    await typeInto(field(el, "Find"), "foo");
    await typeInto(field(el, "Replace"), "baz");
    for (let i = 0; i < 100 && button(el, "Replace all").disabled; i++) await flushUi(100);
    await act(async () => button(el, "Replace all").click());
    const cancel = button(el, "Replacing… Cancel");
    expect(cancel).toBeDefined();
    await act(async () => cancel.click());
    await flushUi();
    expect(button(el, "Replace all")).toBeDefined();
    expect(app.text()).toBe(text);
  });

  it("M21: after switching to a tab that was not loaded yet, the search finds its matches", async () => {
    backend.write(A, "needle in a");
    backend.write(B, "nothing here");
    await app.actions.openPaths([A, B]);
    const a = app.tabByName("a.txt");
    expect(app.engine.hasDoc(a.id)).toBe(false);
    app.actions.openFind(false);
    const el = await renderFindBar();
    await typeInto(field(el, "Find"), "needle");
    await flushUi();
    expect(count(el)).toBe("No results");
    slowReads(100);
    let switching: Promise<void> = Promise.resolve();
    act(() => {
      switching = app.actions.activate(a.id);
    });
    await act(() => switching);
    await flushUi();
    expect(count(el)).toBe("1 of 1");
    // F3 works without typing the query again.
    expect(app.engine.findNext()).toMatchObject({ total: 1 });
  });

  // BUGS.md 1.5: the test above passes even without actions.whenActivated, because the
  // load happens to settle after the activation. Here the activation settles last.
  it("M21: searches again once the activation has put the tab in the editor, even after its load", async () => {
    backend.write(A, "needle in a");
    backend.write(B, "nothing here");
    await app.actions.openPaths([A, B]);
    const a = app.tabByName("a.txt");
    app.actions.openFind(false);
    const el = await renderFindBar();
    await typeInto(field(el, "Find"), "needle");
    await flushUi();
    expect(count(el)).toBe("No results");
    let settleActivation: () => void = () => {};
    const activated = new Promise<void>((resolve) => (settleActivation = resolve));
    vi.spyOn(app.actions, "whenActivated").mockReturnValue(activated);
    const realActivate = app.engine.activate.bind(app.engine);
    const shown: string[] = [];
    // The editor shows the tab only later (as when a slow tab switch ends last).
    vi.spyOn(app.engine, "activate").mockImplementation((id: string) => void shown.push(id));
    let switching: Promise<void> = Promise.resolve();
    act(() => {
      switching = app.actions.activate(a.id);
    });
    await act(() => switching);
    await flushUi(); // the whole file is loaded by now
    expect(shown).toEqual([a.id]);
    await act(async () => {
      realActivate(a.id);
      settleActivation();
    });
    await flushUi();
    expect(count(el)).toBe("1 of 1");
  });

  // BUGS.md UI-5: the counter is the only answer to Enter or F3, so a screen reader must hear it.
  it("the match counter is a polite live region", async () => {
    app.type("one two one");
    app.actions.openFind(false);
    const el = await renderFindBar();
    await typeInto(field(el, "Find"), "one");
    await flushUi();
    const counter = el.querySelector(".find-count")!;
    expect(counter.textContent).toMatch(/of 2/);
    expect(counter.getAttribute("role")).toBe("status");
  });

  it("whole-word and regular-expression toggles change the search; Replace stays literal without regex", async () => {
    app.type("cat concat c4t");
    app.actions.openFind(true);
    const el = await renderFindBar();
    const toggle = (label: string) =>
      act(async () => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    await typeInto(field(el, "Find"), "cat");
    await flushUi();
    expect(count(el)).toMatch(/of 2$/);
    await toggle("Match whole word");
    await flushUi();
    expect(count(el)).toBe("1 of 1");
    await toggle("Match whole word");
    await toggle("Use regular expression");
    await typeInto(field(el, "Find"), "c(\\d)t");
    await flushUi();
    expect(count(el)).toBe("1 of 1");
    await typeInto(field(el, "Replace"), "[$1]");
    await act(async () => button(el, "Replace all").click());
    await flushUi();
    expect(app.text()).toBe("cat concat [4]");
    await typeInto(field(el, "Find"), "(");
    await flushUi();
    expect(count(el)).toBe("Invalid expression");
    // Without regex the same replacement text goes in as typed.
    await toggle("Use regular expression");
    await typeInto(field(el, "Find"), "cat");
    await typeInto(field(el, "Replace"), "$1");
    await act(async () => button(el, "Replace all").click());
    await flushUi();
    expect(app.text()).toBe("$1 con$1 [4]");
  });

  it("M14: a count that finishes in the background updates the counter", async () => {
    app.type(`needle ${"lorem ipsum dolor sit amet\n".repeat(400_000)}needle`);
    app.actions.openFind(false);
    const el = await renderFindBar();
    await typeInto(field(el, "Find"), "needle");
    for (let i = 0; i < 100 && !/^\d+ of 2$/.test(count(el)); i++) await flushUi(100);
    expect(count(el)).toMatch(/^\d+ of 2$/);
  }, 30_000);

  it("UI-5: the status bar is not a live region, so typing does not read it out", async () => {
    const { StatusBar } = await import("./StatusBar");
    const el = document.body.appendChild(document.createElement("div"));
    host = el;
    const r = createRoot(el);
    root = r;
    await act(async () => r.render(createElement(StatusBar)));
    const bar = el.querySelector<HTMLElement>(".statusbar")!;
    expect(bar).not.toBeNull();
    expect(bar.closest("[role='status'], [role='alert'], [role='log'], [aria-live='polite'], [aria-live='assertive']")).toBeNull();
    expect(bar.getAttribute("aria-label")).toBe("Status bar");
  });
});
