// @vitest-environment jsdom
// The tab strip against the real app: the tab context menu and the tab drag gesture.
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

  // F2, as in Chrome: the tab is torn off the moment it leaves the strip, and from
  // then on Rust moves a window with the mouse (Escape there puts it back).
  it("a tab pulled out of the strip is torn off at once and its place closes up", async () => {
    const el = await renderTitleBar();
    const [, b] = await threeTabs();
    const detach = vi.spyOn(app.actions, "detachTab").mockResolvedValue();
    await act(async () => {
      tabEl(el, b).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    // A window waits, booted ahead, for the tab to be torn out into (no blink).
    expect(backend.calls.some((c) => c.cmd === "spare_ensure")).toBe(true);
    window.dispatchEvent(pointer("pointermove", { ...OUT, buttons: 1 }));
    // The new window shows it as its first tab, held at the same point (12 px in at least).
    expect(detach).toHaveBeenCalledWith(b, { x: 12, y: 10 });
    expect(tabEl(el, b).classList.contains("tab-detached")).toBe(true);
    // The strip let go of the drag: more moves, Escape and the release do nothing here.
    window.dispatchEvent(pointer("pointermove", { clientX: 10, clientY: 500, buttons: 1 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    window.dispatchEvent(pointer("pointerup", OUT));
    await settle();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(ids()).toHaveLength(3);
  });

  it("a torn-out tab that could not go gets its place back", async () => {
    const el = await renderTitleBar();
    const [, b] = await threeTabs();
    vi.spyOn(app.actions, "detachTab").mockResolvedValue();
    await act(async () => {
      tabEl(el, b).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    window.dispatchEvent(pointer("pointermove", { ...OUT, buttons: 1 }));
    expect(tabEl(el, b).classList.contains("tab-detached")).toBe(true);
    const { announceTabStrip } = await import("../lib/tabDrag");
    announceTabStrip({ kind: "stay", id: b });
    expect(tabEl(el, b).classList.contains("tab-detached")).toBe(false);
  });

  it("the only tab is not collapsed: its window itself follows the mouse", async () => {
    const el = await renderTitleBar();
    const [only] = ids();
    const detach = vi.spyOn(app.actions, "detachTab").mockResolvedValue();
    await act(async () => {
      tabEl(el, only).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    window.dispatchEvent(pointer("pointermove", { ...OUT, buttons: 1 }));
    expect(detach).toHaveBeenCalledWith(only, { x: 12, y: 10 });
    // Its own window moves: no spare window is needed.
    expect(backend.calls.some((c) => c.cmd === "spare_ensure")).toBe(false);
    expect(tabEl(el, only).classList.contains("tab-detached")).toBe(false);
  });

  it("tabs slide apart where a tab from another window hovers, and back when it leaves", async () => {
    const el = await renderTitleBar();
    const [a, b, c] = await threeTabs();
    const { announceTabStrip, hoverGapIndex } = await import("../lib/tabDrag");
    // jsdom puts every tab at x = 0: a tab hovering at x = 0 goes first.
    announceTabStrip({ kind: "hover", x: 0, y: 10 });
    expect(hoverGapIndex()).toBe(0);
    for (const id of [a, b, c]) expect(tabEl(el, id).style.transform).toBe("translateX(233px)");
    announceTabStrip({ kind: "hover", x: 50, y: 10 });
    expect(hoverGapIndex()).toBe(3);
    expect(tabEl(el, c).style.transform).toBe("");
    announceTabStrip({ kind: "leave", dropping: false });
    expect(hoverGapIndex()).toBeNull();
    for (const id of [a, b, c]) expect(tabEl(el, id).style.transform).toBe("");
  });

  it("a tab from another window snaps in under the mouse, held where it was grabbed", async () => {
    const el = await renderTitleBar();
    await threeTabs();
    const { announceTabStrip } = await import("../lib/tabDrag");
    await act(async () => {
      announceTabStrip({ kind: "hover", x: 100, y: 10, title: "notes.md", dirty: true, grabX: 40 });
    });
    const phantom = el.querySelector<HTMLElement>(".tab-phantom");
    expect(phantom?.textContent).toContain("notes.md");
    expect(phantom?.dataset.dirty).toBe("true");
    // Held 40 px into the tab: its left edge is 40 px left of the mouse.
    expect(phantom?.style.left).toBe("60px");
    await act(async () => {
      announceTabStrip({ kind: "hover", x: 150, y: 10, title: "notes.md", dirty: true, grabX: 40 });
    });
    expect(el.querySelector<HTMLElement>(".tab-phantom")?.style.left).toBe("110px");
    // Pulled out again without letting go: it leaves this strip.
    await act(async () => {
      announceTabStrip({ kind: "leave", dropping: false });
    });
    expect(el.querySelector(".tab-phantom")).toBeNull();
  });

  it("a dropped tab keeps its gap until it arrives, then slides from the mouse into it", async () => {
    const el = await renderTitleBar();
    const [a] = await threeTabs();
    const { announceTabStrip, hoverGapIndex } = await import("../lib/tabDrag");
    await act(async () => {
      announceTabStrip({ kind: "hover", x: 0, y: 10, title: "a", dirty: false });
      announceTabStrip({ kind: "leave", dropping: true });
    });
    expect(hoverGapIndex()).toBe(0);
    expect(tabEl(el, a).style.transform).toBe("translateX(233px)");
    expect(el.querySelector(".tab-phantom")).not.toBeNull();
    await act(async () => {
      announceTabStrip({ kind: "arrived", id: a });
    });
    expect(hoverGapIndex()).toBeNull();
    expect(el.querySelector(".tab-phantom")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    // Starts where the snapped-in tab was shown, then glides into its place.
    expect(tabEl(el, a).style.transform).toBe("translateX(-116.5px)");
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(tabEl(el, a).style.transform).toBe("");
  });

  it("a tab that arrives without hovering first rises into its place", async () => {
    const el = await renderTitleBar();
    const [a] = await threeTabs();
    const { announceTabStrip } = await import("../lib/tabDrag");
    await act(async () => {
      announceTabStrip({ kind: "arrived", id: a });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(tabEl(el, a).classList.contains("tab-arriving")).toBe(true);
  });

  it("a drop that never arrives gives its gap up after a while", async () => {
    await renderTitleBar();
    await threeTabs();
    const { announceTabStrip, hoverGapIndex } = await import("../lib/tabDrag");
    announceTabStrip({ kind: "hover", x: 0, y: 10 });
    announceTabStrip({ kind: "leave", dropping: true });
    expect(hoverGapIndex()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(hoverGapIndex()).toBeNull();
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

describe("Escape during a tab drag (BUGS.md UI-13)", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  it("cancels the drag only: the find bar stays open", async () => {
    const el = await renderTitleBar();
    const [a] = await threeTabs();
    app.actions.openFind(false);
    expect(app.state().find.open).toBe(true);
    await act(async () => {
      tabEl(el, a).dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, buttons: 1 }));
    });
    window.dispatchEvent(pointer("pointermove", { clientX: 60, clientY: 10, buttons: 1 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(tabEl(el, a).classList.contains("dragging")).toBe(false);
    expect(app.state().find.open).toBe(true);
    // Without a drag, Escape closes the find bar as before.
    window.dispatchEvent(pointer("pointerup", { clientX: 60, clientY: 10 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(app.state().find.open).toBe(false);
  });
});

describe("tab strip for keyboard and screen readers", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  it("says a tab is unsaved in its accessible name", async () => {
    const el = await renderTitleBar();
    const id = app.state().activeId;
    expect(tabEl(el, id).getAttribute("aria-label")).toBe("Untitled");
    await act(async () => app.type("hello"));
    await act(async () => settle(50));
    const title = app.tab().title;
    expect(app.tab().dirty).toBe(true);
    expect(tabEl(el, id).getAttribute("aria-label")).toBe(`${title}, unsaved`);
  });

  it("Home and End move the focus to the first and last tab", async () => {
    const el = await renderTitleBar();
    const [a, , c] = await threeTabs();
    await act(async () => settle());
    const middle = el.querySelectorAll<HTMLElement>("[role='tab']")[1];
    middle.focus();
    await act(async () => {
      middle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(tabEl(el, c));
    await act(async () => {
      tabEl(el, c).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(tabEl(el, a));
  });

  it("has no focusable control nested inside a tab", async () => {
    const el = await renderTitleBar();
    await threeTabs();
    await act(async () => settle());
    for (const tab of el.querySelectorAll("[role='tab']")) {
      for (const inner of tab.querySelectorAll<HTMLElement>("button, [tabindex]")) {
        expect(inner.tabIndex).toBe(-1);
        expect(inner.getAttribute("aria-hidden")).toBe("true");
      }
    }
  });

  it("the tab menu moves a tab to a new window", async () => {
    const el = await renderTitleBar();
    const [, b] = await threeTabs();
    const moveOut = vi.spyOn(app.actions, "moveTabOut").mockResolvedValue();
    await act(async () => {
      tabEl(el, b).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
    });
    const item = [...el.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent?.includes("Move to new window"))!;
    expect(item).toBeTruthy();
    await act(async () => item.click());
    expect(moveOut).toHaveBeenCalledWith(b, true);
  });

  it("Move to new window is off for the only tab", async () => {
    const el = await renderTitleBar();
    await act(async () => {
      tabEl(el, app.state().activeId).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
    });
    const item = [...el.querySelectorAll<HTMLElement>("[role='menuitem']")].find((i) => i.textContent?.includes("Move to new window"))!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });
});
