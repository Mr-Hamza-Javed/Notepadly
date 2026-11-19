// @vitest-environment jsdom
// Menus for keyboard and screen reader users.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, type MenuEntry } from "./Menu";

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
