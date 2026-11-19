// @vitest-environment jsdom
// The status bar against the real app: the line ending and encoding pickers and the mode button.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootApp, settle, type App } from "../test/appHarness";
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

const FILE = "C:\\notes\\a.txt";

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

async function renderStatusBar(): Promise<HTMLElement> {
  const { StatusBar } = await import("./StatusBar");
  const el = document.body.appendChild(document.createElement("div"));
  host = el;
  const r = createRoot(el);
  root = r;
  await act(async () => r.render(createElement(StatusBar)));
  return el;
}

const picker = (el: HTMLElement, cell: string) => el.querySelector<HTMLButtonElement>(`.${cell} .sb-btn`)!;
const items = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[role='menu']:last-of-type [role^='menuitem']")];
const item = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll<HTMLElement>("[role^='menuitem']")].find((i) => i.querySelector(".mi-label")?.textContent === label)!;

describe("status bar pickers", () => {
  beforeEach(async () => {
    app = await bootApp();
    backend.write(FILE, "one\r\ntwo");
    await app.actions.openPaths([FILE]);
  });

  it("the line ending picker shows the choices, marks the current one and changes it", async () => {
    const el = await renderStatusBar();
    const button = picker(el, "sb-eol");
    expect(button.textContent).toBe("Windows (CRLF)");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const choices = items(el);
    expect(choices.map((c) => c.querySelector(".mi-label")?.textContent)).toEqual(["Windows (CRLF)", "Unix (LF)", "Macintosh (CR)"]);
    expect(choices.map((c) => c.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await act(async () => item(el, "Unix (LF)").click());
    expect(el.querySelector("[role='menu']")).toBeNull();
    expect(app.tab().eol).toBe("LF");
    expect(app.tab().dirty).toBe(true);
    expect(picker(el, "sb-eol").textContent).toBe("Unix (LF)");
  });

  it("the encoding picker changes how the file is saved", async () => {
    const el = await renderStatusBar();
    await act(async () => picker(el, "sb-enc").click());
    await act(async () => item(el, "UTF-16 LE").click());
    expect(app.tab().encoding).toBe("utf-16le");
    expect(picker(el, "sb-enc").textContent).toBe("UTF-16 LE");
  });

  it("offers Reopen with encoding only for a file on disk", async () => {
    const el = await renderStatusBar();
    await act(async () => picker(el, "sb-enc").click());
    expect(item(el, "Reopen with encoding")).toBeTruthy();
    await act(async () => picker(el, "sb-enc").click());
    await act(async () => app.actions.newTab());
    await act(async () => picker(el, "sb-enc").click());
    expect(item(el, "Reopen with encoding")).toBeUndefined();
  });

  it("Escape closes a picker without changing anything", async () => {
    const el = await renderStatusBar();
    await act(async () => picker(el, "sb-eol").click());
    const menu = el.querySelector<HTMLElement>("[role='menu']")!;
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(el.querySelector("[role='menu']")).toBeNull();
    expect(app.tab().eol).toBe("CRLF");
    expect(app.tab().dirty).toBe(false);
  });

  // New bug: aria-label "Line endings" replaced the button's text, so a screen
  // reader never heard the current value.
  it("a picker's accessible name includes its current value", async () => {
    const el = await renderStatusBar();
    expect(picker(el, "sb-eol").getAttribute("aria-label")).toBe("Line endings: Windows (CRLF)");
    expect(picker(el, "sb-enc").getAttribute("aria-label")).toMatch(/^Encoding: /);
  });

  it("the mode button switches the view", async () => {
    const el = await renderStatusBar();
    const before = app.tab().mode;
    await act(async () => el.querySelector<HTMLButtonElement>(".sb-mode .sb-btn")!.click());
    await act(async () => settle());
    expect(app.tab().mode).not.toBe(before);
  });
});
