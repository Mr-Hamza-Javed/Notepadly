// @vitest-environment jsdom
// The Settings and Help pages, and keyboard tooltips, against the real app.
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootApp, type App } from "../test/appHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chordToCommand, type Chord } from "../lib/shortcuts";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.3" }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

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

async function render(component: ComponentType): Promise<HTMLElement> {
  const el = document.body.appendChild(document.createElement("div"));
  host = el;
  const r = createRoot(el);
  root = r;
  await act(async () => r.render(createElement(component)));
  return el;
}

const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });

const byText = (el: HTMLElement, selector: string, text: string) =>
  [...el.querySelectorAll<HTMLElement>(selector)].find((n) => n.textContent?.includes(text))!;

describe("Settings page", () => {
  beforeEach(async () => {
    app = await bootApp();
    app.actions.openSettings();
  });

  async function openThemes(el: HTMLElement): Promise<HTMLElement> {
    await act(async () => byText(el, ".card-head", "App theme").click());
    return el.querySelector<HTMLElement>("[role='radiogroup'][aria-label='App theme']")!;
  }

  it("a radio group is one Tab stop: the checked option", async () => {
    const { default: Settings } = await import("./Settings");
    const el = await render(Settings);
    const group = await openThemes(el);
    const radios = [...group.querySelectorAll<HTMLElement>("[role='radio']")];
    expect(radios.length).toBeGreaterThan(1);
    const checked = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(radios.map((r) => r.tabIndex)).toEqual(radios.map((r) => (r === checked[0] ? 0 : -1)));
  });

  it("the arrow keys move the choice and the focus, wrapping at the ends", async () => {
    const { default: Settings } = await import("./Settings");
    const el = await render(Settings);
    const group = await openThemes(el);
    const radios = () => [...group.querySelectorAll<HTMLElement>("[role='radio']")];
    const start = radios().findIndex((r) => r.getAttribute("aria-checked") === "true");
    const before = app.state().settings.theme;
    radios()[start].focus();
    await key(radios()[start], "ArrowDown");
    const next = (start + 1) % radios().length;
    expect(radios()[next].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios()[next]);
    expect(app.state().settings.theme).not.toBe(before);
    await key(radios()[next], "ArrowUp");
    expect(radios()[start].getAttribute("aria-checked")).toBe("true");
    await key(radios()[start], "End");
    expect(radios().at(-1)!.getAttribute("aria-checked")).toBe("true");
    await key(radios().at(-1)!, "ArrowDown");
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
  });

  it("a switch changes its setting and says so", async () => {
    const { default: Settings } = await import("./Settings");
    const el = await render(Settings);
    const wrap = el.querySelector<HTMLElement>("[role='switch'][aria-label='Word wrap']")!;
    const before = app.state().settings.wordWrap;
    expect(wrap.getAttribute("aria-checked")).toBe(String(before));
    await act(async () => wrap.click());
    expect(app.state().settings.wordWrap).toBe(!before);
    expect(wrap.getAttribute("aria-checked")).toBe(String(!before));
  });

  it("Back and Alt+Left return to the editor", async () => {
    const { default: Settings } = await import("./Settings");
    const el = await render(Settings);
    await act(async () => el.querySelector<HTMLElement>(".settings-back")!.click());
    expect(app.state().view).toBe("editor");
    app.actions.openSettings();
    await key(window as unknown as Element, "ArrowLeft", { altKey: true });
    expect(app.state().view).toBe("editor");
  });
});

/** Parses a Help key label as the user would press it ("Ctrl++" is Ctrl and Plus). */
function labelChord(label: string): Chord {
  const parts = label.split(/\+(?!$)/);
  const name = parts[parts.length - 1];
  return {
    key: name.length === 1 ? name.toLowerCase() : name,
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

describe("Help page", () => {
  beforeEach(async () => {
    app = await bootApp();
    app.actions.openHelp();
  });

  it("search narrows the topics, and says when nothing matches", async () => {
    const { default: Help } = await import("./Help");
    const el = await render(Help);
    const all = el.querySelectorAll(".help-card").length;
    expect(all).toBeGreaterThan(3);
    const search = el.querySelector<HTMLInputElement>("input[type='search']")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(search, "keyboard");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const titles = [...el.querySelectorAll(".help-card h2")].map((h) => h.textContent);
    expect(titles).toContain("All keyboard shortcuts");
    expect(titles.length).toBeLessThan(all);
    await act(async () => {
      setter.call(search, "zzzz-nothing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.querySelector(".help-empty")).not.toBeNull();
  });

  it("every shortcut in the shortcut list does what it says", async () => {
    const { default: Help } = await import("./Help");
    const el = await render(Help);
    const table = el.querySelector("#help-shortcuts table")!;
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      const keys = [...row.querySelectorAll("td:first-child kbd")].map((k) => k.textContent ?? "");
      const label = keys.join("+");
      if (label === "Esc") continue; // handled by whatever is open, not a command
      expect(chordToCommand(labelChord(label)), label).not.toBeNull();
    }
  });

  // New bug: Ctrl++ showed "Ctrl" and two empty key caps.
  it("shows Ctrl++ as the Ctrl and + keys", async () => {
    const { default: Help } = await import("./Help");
    const el = await render(Help);
    const row = byText(el, "#help-shortcuts tbody tr", "Zoom in");
    expect([...row.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl", "+"]);
    for (const kbd of el.querySelectorAll("kbd")) expect(kbd.textContent, "empty key cap").not.toBe("");
  });

  it("Back returns to the editor", async () => {
    const { default: Help } = await import("./Help");
    const el = await render(Help);
    await act(async () => el.querySelector<HTMLElement>(".settings-back")!.click());
    expect(app.state().view).toBe("editor");
  });
});

describe("tooltips", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  async function renderWithButton(): Promise<{ tip: HTMLElement; button: HTMLButtonElement }> {
    const { Tooltip } = await import("./Tooltip");
    const el = await render(Tooltip);
    const button = document.body.appendChild(document.createElement("button"));
    button.setAttribute("data-tip", "Match case");
    return { tip: el.querySelector<HTMLElement>("[role='tooltip']")!, button };
  }

  it("show on keyboard focus", async () => {
    const { tip, button } = await renderWithButton();
    vi.useFakeTimers();
    try {
      const matches = vi.spyOn(button, "matches").mockImplementation((s: string) => s === ":focus-visible");
      button.focus();
      await vi.advanceTimersByTimeAsync(600);
      expect(tip.classList.contains("show")).toBe(true);
      expect(tip.textContent).toBe("Match case");
      button.blur();
      expect(tip.classList.contains("show")).toBe(false);
      matches.mockRestore();
    } finally {
      vi.useRealTimers();
      button.remove();
    }
  });

  it("do not show on a mouse click's focus", async () => {
    const { tip, button } = await renderWithButton();
    vi.useFakeTimers();
    try {
      vi.spyOn(button, "matches").mockReturnValue(false);
      button.focus();
      await vi.advanceTimersByTimeAsync(600);
      expect(tip.classList.contains("show")).toBe(false);
    } finally {
      vi.useRealTimers();
      button.remove();
    }
  });
});

