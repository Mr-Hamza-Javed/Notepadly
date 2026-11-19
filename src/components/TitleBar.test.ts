// @vitest-environment jsdom
// The tab strip against the real app: the tab context menu and the tab drag gesture.
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

/** jsdom has no PointerEvent: a MouseEvent with the pointer fields is enough for the strip. */
function pointer(type: string, init: MouseEventInit & { pointerId?: number } = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return event;
}

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

describe("tab drag", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  // In jsdom every box is 0x0 at (0, 0): 32 px below the strip is "pulled out".
  const OUT = { clientX: 10, clientY: 300 };

  // BUGS.md UI-3
  it("Escape cancels a tab pulled out of the strip", async () => {
    const el = await renderTitleBar();
    const [a] = await threeTabs();
    const moveOut = vi.spyOn(app.actions, "moveTabOut").mockResolvedValue();
    await act(async () => {
      tabEl(el, a).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    window.dispatchEvent(pointer("pointermove", { ...OUT, buttons: 1 }));
    expect(tabEl(el, a).classList.contains("detaching")).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(tabEl(el, a).classList.contains("detaching")).toBe(false);
    window.dispatchEvent(pointer("pointerup", OUT));
    await settle();
    expect(moveOut).not.toHaveBeenCalled();
  });

  it("Escape cancels a reorder", async () => {
    const el = await renderTitleBar();
    const before = await threeTabs();
    await act(async () => {
      tabEl(el, before[0]).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    window.dispatchEvent(pointer("pointermove", { clientX: 60, clientY: 10, buttons: 1 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    window.dispatchEvent(pointer("pointerup", { clientX: 60, clientY: 10 }));
    await settle();
    expect(ids()).toEqual(before);
  });

  it("a button released where the window did not see it ends the drag without moving the tab", async () => {
    const el = await renderTitleBar();
    const [a] = await threeTabs();
    const moveOut = vi.spyOn(app.actions, "moveTabOut").mockResolvedValue();
    await act(async () => {
      tabEl(el, a).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    window.dispatchEvent(pointer("pointermove", { ...OUT, buttons: 1 }));
    // The release happened outside (capture lost): the next move has no button down.
    window.dispatchEvent(pointer("pointermove", { ...OUT, buttons: 0 }));
    expect(tabEl(el, a).classList.contains("dragging")).toBe(false);
    // A later, unrelated click in the editor must not move the tab out.
    window.dispatchEvent(pointer("pointerdown", { ...OUT, buttons: 1 }));
    window.dispatchEvent(pointer("pointerup", OUT));
    await settle();
    expect(moveOut).not.toHaveBeenCalled();
  });

  it("a tab closed during the drag does not reorder the others on release", async () => {
    const el = await renderTitleBar();
    const [a, b, c] = await threeTabs();
    await act(async () => {
      tabEl(el, a).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    window.dispatchEvent(pointer("pointermove", { clientX: 60, clientY: 10, buttons: 1 }));
    await act(async () => {
      await app.actions.closeTab(a); // Ctrl+W with the mouse still down
    });
    window.dispatchEvent(pointer("pointerup", { clientX: 60, clientY: 10 }));
    await settle();
    expect(ids()).toEqual([b, c]);
  });

  it("a normal drag still reorders", async () => {
    const el = await renderTitleBar();
    const [a, b, c] = await threeTabs();
    await act(async () => {
      tabEl(el, a).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    window.dispatchEvent(pointer("pointermove", { clientX: 60, clientY: 10, buttons: 1 }));
    window.dispatchEvent(pointer("pointerup", { clientX: 60, clientY: 10 }));
    await settle();
    expect(ids()).toEqual([b, c, a]);
  });
});
