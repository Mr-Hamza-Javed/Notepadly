// @vitest-environment jsdom
// The tab strip against the real app: the tab context menu.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootApp, settle, type App } from "../test/appHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

let app: App;
let root: Root | null = null;
let host: HTMLElement | null = null;

async function renderTitleBar(): Promise<HTMLElement> {
  // Imported after bootApp, which resets the modules, so the strip talks to this app.
  const { TitleBar } = await import("./TitleBar");
  const el = document.body.appendChild(document.createElement("div"));
  host = el;
  const r = createRoot(el);
  root = r;
  await act(async () => r.render(createElement(TitleBar)));
  return el;
}

afterEach(async () => {
  const r = root;
  if (r) await act(async () => r.unmount());
  host?.remove();
  root = null;
  host = null;
});

const tabEl = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
const ids = () => app.state().tabs.map((t) => t.id);

async function threeTabs(): Promise<string[]> {
  await app.actions.newTab();
  await app.actions.newTab();
  await settle();
  return ids();
}

describe("tab context menu", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  // BUGS.md UI-2: the menu of a tab that has gone acted on every tab.
  it("closes when its tab goes, so Close to the right cannot close every tab", async () => {
    const el = await renderTitleBar();
    const [a, b, c] = await threeTabs();
    await act(async () => {
      tabEl(el, b).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
    });
    expect(el.querySelector("[role='menu']")).not.toBeNull();
    await act(async () => {
      await app.actions.closeTab(b);
    });
    expect(el.querySelector("[role='menu']")).toBeNull();
    expect(ids()).toEqual([a, c]);
  });

  it("Close to the right and Close others of a tab that is gone close nothing", async () => {
    const [a, b, c] = await threeTabs();
    await app.actions.closeToRight("gone");
    await app.actions.closeOthers("gone");
    await settle();
    expect(ids()).toEqual([a, b, c]);
  });

  it("app shortcuts do not run while a menu has the focus", async () => {
    const el = await renderTitleBar();
    const [, b] = await threeTabs();
    await act(async () => {
      tabEl(el, b).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
    });
    const menu = el.querySelector<HTMLElement>("[role='menu']")!;
    const event = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      menu.dispatchEvent(event);
    });
    await settle();
    expect(app.state().tabs).toHaveLength(3);
    // The WebView default is still blocked.
    expect(event.defaultPrevented).toBe(true);
  });
});
