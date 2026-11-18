// @vitest-environment jsdom
import "../test/dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY_SETTINGS = "notepadly.settings.v1";
const KEY_RECENT = "notepadly.recent.v1";
const KEY_PAGE = "notepadly.pageSetup.v1";

async function freshStore(saved: Record<string, string> = {}) {
  vi.resetModules();
  localStorage.clear();
  for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
  return import("./store");
}

describe("store: loading saved preferences", () => {
  it("starts from defaults with nothing saved", async () => {
    const { useApp } = await freshStore();
    const state = useApp.getState();
    expect(state.settings.theme).toBe("system");
    expect(state.recent).toEqual([]);
    expect(state.pageSetup.orientation).toBe("portrait");
    expect(state.tabs).toHaveLength(1);
    expect(state.activeId).toBe(state.tabs[0].id);
  });

  it("reads valid saved preferences", async () => {
    const { useApp } = await freshStore({
      [KEY_SETTINGS]: JSON.stringify({ theme: "dark", formatting: false }),
      [KEY_RECENT]: JSON.stringify(["C:\\a.md"]),
      [KEY_PAGE]: JSON.stringify({ orientation: "landscape" }),
    });
    const state = useApp.getState();
    expect(state.settings).toMatchObject({ theme: "dark", formatting: false });
    expect(state.dark).toBe(true);
    expect(state.tabs[0].mode).toBe("plain");
    expect(state.recent).toEqual(["C:\\a.md"]);
    expect(state.pageSetup.orientation).toBe("landscape");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ignores corrupt or wrongly typed saved data", async () => {
    const { useApp } = await freshStore({
      [KEY_SETTINGS]: "{broken",
      [KEY_RECENT]: JSON.stringify({ not: "a list" }),
      [KEY_PAGE]: "null",
    });
    const state = useApp.getState();
    expect(state.settings.zoom).toBe(100);
    expect(state.recent).toEqual([]);
    expect(state.pageSetup.marginMm).toBe(20);
  });
});

describe("store: saving preferences", () => {
  let store: Awaited<ReturnType<typeof freshStore>>;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("writes only what changed", () => {
    const { useApp, flushPersistedPrefs } = store;
    useApp.setState((s) => ({ settings: { ...s.settings, zoom: 150 } }));
    flushPersistedPrefs();
    expect(JSON.parse(localStorage.getItem(KEY_SETTINGS)!).zoom).toBe(150);
    expect(localStorage.getItem(KEY_RECENT)).toBeNull();
    expect(localStorage.getItem(KEY_PAGE)).toBeNull();
  });

  it("writes on its own after a short pause", async () => {
    store.useApp.setState({ recent: ["C:\\x.md"] });
    expect(localStorage.getItem(KEY_RECENT)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(JSON.parse(localStorage.getItem(KEY_RECENT)!)).toEqual(["C:\\x.md"]);
  });

  it("writes when the page is hidden, so a quick close loses nothing", () => {
    store.useApp.setState({ recent: ["C:\\y.md"] });
    window.dispatchEvent(new Event("pagehide"));
    expect(JSON.parse(localStorage.getItem(KEY_RECENT)!)).toEqual(["C:\\y.md"]);
  });

  it("keeps working when storage is full", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    store.useApp.setState((s) => ({ settings: { ...s.settings, zoom: 120 } }));
    expect(() => store.flushPersistedPrefs()).not.toThrow();
    expect(store.useApp.getState().settings.zoom).toBe(120);
    setItem.mockRestore();
  });

  it("switches the page theme when the theme setting changes", () => {
    store.useApp.setState((s) => ({ settings: { ...s.settings, theme: "dark" } }));
    expect(store.useApp.getState().dark).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    store.useApp.setState((s) => ({ settings: { ...s.settings, theme: "light" } }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("store: tab updates", () => {
  it("patchTab changes one tab and leaves the others untouched", async () => {
    const { useApp, patchTab, makeUntitledTab } = await freshStore();
    const second = makeUntitledTab(true);
    useApp.setState((s) => ({ tabs: [...s.tabs, second] }));
    const before = useApp.getState().tabs;
    patchTab(second.id, { title: "Renamed", dirty: true });
    const after = useApp.getState().tabs;
    expect(after[1]).toMatchObject({ title: "Renamed", dirty: true });
    expect(after[0]).toBe(before[0]);
  });

  it("patchTab with unchanged values does not notify subscribers", async () => {
    const { useApp, patchTab } = await freshStore();
    const id = useApp.getState().activeId;
    const listener = vi.fn();
    const unsubscribe = useApp.subscribe(listener);
    patchTab(id, { dirty: false, title: "Untitled" });
    patchTab("missing-id", { dirty: true });
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });

  it("new tab ids are unique", async () => {
    const { newTabId } = await freshStore();
    const ids = new Set(Array.from({ length: 1000 }, newTabId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});

describe("store: sharing preferences between windows (H12)", () => {
  // Store modules from earlier tests still listen for storage events; let their
  // pending writes run out first so they do not answer for this test's window.
  beforeEach(() => new Promise((resolve) => setTimeout(resolve, 450)));

  /** What another window does: write the key, then the browser tells this one. */
  function otherWindowWrites(key: string, value: unknown) {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }

  it("takes in settings and Recent changed in another window", async () => {
    const { useApp, onSharedSettings } = await freshStore();
    const seen: string[] = [];
    onSharedSettings((before, after) => seen.push(`${before.theme}->${after.theme}`));
    otherWindowWrites(KEY_SETTINGS, { ...useApp.getState().settings, theme: "dark", fontSizePt: 14 });
    otherWindowWrites(KEY_RECENT, ["C:\\other.md"]);
    expect(useApp.getState().settings).toMatchObject({ theme: "dark", fontSizePt: 14 });
    expect(useApp.getState().dark).toBe(true);
    expect(useApp.getState().recent).toEqual(["C:\\other.md"]);
    expect(seen).toEqual(["system->dark"]);
  });

  it("does not write back what it took in from another window", async () => {
    const { useApp } = await freshStore();
    localStorage.setItem(KEY_SETTINGS, JSON.stringify({ ...useApp.getState().settings, zoom: 130 }));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(new StorageEvent("storage", { key: KEY_SETTINGS }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(useApp.getState().settings.zoom).toBe(130);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("a later change in an older window keeps the other window's change", async () => {
    const { useApp, flushPersistedPrefs } = await freshStore();
    // The other window changed the theme; this one has not heard of it yet.
    localStorage.setItem(KEY_SETTINGS, JSON.stringify({ ...useApp.getState().settings, theme: "dark" }));
    useApp.setState((s) => ({ settings: { ...s.settings, fontSizePt: 16 } }));
    flushPersistedPrefs();
    expect(JSON.parse(localStorage.getItem(KEY_SETTINGS)!)).toMatchObject({ theme: "dark", fontSizePt: 16 });
    expect(useApp.getState().settings).toMatchObject({ theme: "dark", fontSizePt: 16 });
  });

  it("a file opened in an older window joins the Recent list instead of replacing it", async () => {
    const { useApp, flushPersistedPrefs } = await freshStore({ [KEY_RECENT]: JSON.stringify(["C:\\a.md", "C:\\b.md"]) });
    localStorage.setItem(KEY_RECENT, JSON.stringify(["C:\\c.md", "C:\\a.md", "C:\\b.md"]));
    useApp.setState({ recent: ["C:\\d.md", "C:\\a.md", "C:\\b.md"] });
    flushPersistedPrefs();
    expect(JSON.parse(localStorage.getItem(KEY_RECENT)!)).toEqual(["C:\\d.md", "C:\\c.md", "C:\\a.md", "C:\\b.md"]);
  });
});
