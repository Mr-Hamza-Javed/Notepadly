// @vitest-environment jsdom
// Menus for keyboard and screen reader users.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, type MenuEntry } from "./Menu";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  const r = root;
  if (r) await act(async () => r.unmount());
  host?.remove();
  root = null;
  host = null;
  // The editor booted by some tests answers focus changes on a short timer: let it run
  // while the window still exists (otherwise an unhandled error after teardown).
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 60)));
});

async function renderMenu(entries: MenuEntry[], initialActive = -1): Promise<HTMLElement> {
  const el = document.body.appendChild(document.createElement("div"));
  host = el;
  const r = createRoot(el);
  root = r;
  const anchor = { left: 0, right: 0, top: 0, bottom: 0 };
  await act(async () => r.render(createElement(Menu, { entries, anchor, onClose: vi.fn(), initialActive })));
  return el.querySelector<HTMLElement>("[role='menu']")!;
}

const key = (target: HTMLElement, k: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });

/** The item a screen reader announces: the focused menu's active descendant. */
const announced = (menu: HTMLElement) => {
  const id = menu.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

const ENTRIES: MenuEntry[] = [
  { id: "new", label: "New tab", shortcut: "Ctrl+N" },
  { kind: "sep" },
  { id: "off", label: "Disabled", disabled: true },
  { id: "open", label: "Open", shortcut: "Ctrl+O" },
];

describe("menu accessibility", () => {
  // BUGS.md UI-4: the focus stays on the menu box, so the highlighted item must be its active descendant.
  it("tells screen readers which item the arrow keys highlight", async () => {
    const menu = await renderMenu(ENTRIES);
    expect(document.activeElement).toBe(menu);
    expect(menu.hasAttribute("aria-activedescendant")).toBe(false);
    await key(menu, "ArrowDown");
    expect(announced(menu)).toBe("New tabCtrl+N");
    await key(menu, "ArrowDown");
    expect(announced(menu)).toBe("OpenCtrl+O");
  });

  it("names the item a menu opened from the keyboard starts on", async () => {
    const menu = await renderMenu(ENTRIES, 3);
    expect(announced(menu)).toBe("OpenCtrl+O");
  });

  it("gives two open menus different item ids", async () => {
    const first = await renderMenu(ENTRIES, 0);
    const other = document.body.appendChild(document.createElement("div"));
    const r = createRoot(other);
    await act(async () =>
      r.render(createElement(Menu, { entries: ENTRIES, anchor: { left: 0, right: 0, top: 0, bottom: 0 }, onClose: vi.fn(), initialActive: 0, autoFocus: false })),
    );
    const second = other.querySelector<HTMLElement>("[role='menu']")!;
    expect(first.getAttribute("aria-activedescendant")).not.toBe(second.getAttribute("aria-activedescendant"));
    await act(async () => r.unmount());
    other.remove();
  });
});

describe("menu access keys", () => {
  const press = (target: HTMLElement, init: KeyboardEventInit) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });

  it("runs the item whose access key is pressed, when it is the only one", async () => {
    const save = vi.fn();
    const saveAs = vi.fn();
    const menu = await renderMenu([
      { id: "save", label: "Save", accessKey: "s", onSelect: save },
      { id: "saveas", label: "Save as", accessKey: "a", onSelect: saveAs },
    ]);
    await press(menu, { key: "s" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("also takes the key with Alt still held, and from a non-Latin layout", async () => {
    const save = vi.fn();
    const menu = await renderMenu([
      { id: "new", label: "New tab", accessKey: "t" },
      { id: "save", label: "Save", accessKey: "s", onSelect: save },
    ]);
    await press(menu, { key: "س", code: "KeyS", altKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("moves between items that share an access key instead of running one", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const menu = await renderMenu([
      { id: "a", label: "Close", accessKey: "c", onSelect: first },
      { id: "b", label: "Copy", accessKey: "c", onSelect: second },
    ]);
    await press(menu, { key: "c" });
    expect(announced(menu)).toBe("Close");
    await press(menu, { key: "c" });
    expect(announced(menu)).toBe("Copy");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("ignores a disabled item's access key", async () => {
    const cut = vi.fn();
    const menu = await renderMenu([{ id: "cut", label: "Cut", accessKey: "t", disabled: true, onSelect: cut }]);
    await press(menu, { key: "t" });
    expect(cut).not.toHaveBeenCalled();
  });

  it("marks the access key letter for the underline", async () => {
    const menu = await renderMenu([{ id: "saveas", label: "Save as", accessKey: "a" }]);
    expect(menu.querySelector(".mi-key")?.textContent).toBe("a");
    expect(menu.querySelector("[role='menuitem']")?.getAttribute("aria-keyshortcuts")).toBe("A");
  });

  it("gives every item of the app's menus a unique access key from its label", async () => {
    vi.resetModules();
    const { bootApp } = await import("../test/appHarness");
    await bootApp();
    const { buildMenu } = await import("./menus");
    const check = (entries: MenuEntry[], where: string) => {
      const seen = new Set<string>();
      for (const entry of entries) {
        if (entry.kind === "sep" || entry.id === "none") continue;
        expect(entry.accessKey, `${where}: ${entry.label}`).toBeTruthy();
        expect(entry.label.toLowerCase(), where).toContain(entry.accessKey!);
        expect(seen.has(entry.accessKey!), `${where}: ${entry.label} repeats ${entry.accessKey}`).toBe(false);
        seen.add(entry.accessKey!);
        if (entry.submenu && entry.id !== "recent") check(entry.submenu, entry.label);
      }
    };
    for (const id of ["file", "edit", "view"] as const) check(buildMenu(id), id);
  });
});

describe("Alt, F, S from the menu bar", () => {
  it("saves, as in Notepad", async () => {
    vi.resetModules();
    const { bootApp } = await import("../test/appHarness");
    const app = await bootApp();
    const save = vi.spyOn(app.actions, "save").mockResolvedValue(true);
    const { MenuBar } = await import("./MenuBar");
    const el = document.body.appendChild(document.createElement("div"));
    host = el;
    const r = createRoot(el);
    root = r;
    await act(async () => r.render(createElement(MenuBar)));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", altKey: true, bubbles: true, cancelable: true }));
    });
    const menu = el.querySelector<HTMLElement>("[role='menu']")!;
    expect(menu).not.toBeNull();
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", bubbles: true, cancelable: true }));
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(el.querySelector("[role='menu']")).toBeNull();
  });
});
