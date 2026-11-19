// Boots the real app modules (store, actions, loader, engine) against the fake
// Tauri backend. The test file must mock the Tauri modules with `tauriMocks`.
import "./dom";
import { vi } from "vitest";
import type { Settings } from "../state/types";
import { backend, dialogs, FakeWindow, fakeWindow, fakeWindows, tauriMocks } from "./fakeTauri";

export interface BootOptions {
  /** Saved settings, as localStorage would hold them. */
  settings?: Partial<Settings>;
  recent?: string[];
  /** Window label; only "main" restores and writes the session. */
  label?: string;
  /** Keep the fake backend's files, session and drafts from a previous boot. */
  keepDisk?: boolean;
  /** Answers to yes/no questions asked while starting (see FakeDialogs.askAnswers). */
  askAnswers?: boolean[];
  /**
   * Boots a second window next to the apps already running, with its own
   * FakeWindow (and so its own module graph, store and loader) over the same
   * backend. Events between the windows are delivered (see `fakeWindows`).
   * Implies `keepDisk`.
   */
  window?: FakeWindow;
}

/** The loader of the previous boot, so its pending timers can be silenced like a closed process. */
let previousLoader: typeof import("../lib/loader") | null = null;

export async function bootApp(options: BootOptions = {}) {
  const extra = !!options.window && options.window !== fakeWindow;
  const win = options.window ?? fakeWindow;
  if (!extra) previousLoader?.setPersistence(false);
  vi.resetModules();
  // Each window's modules get Tauri mocks bound to that window.
  vi.doMock("@tauri-apps/api/core", () => tauriMocks.core(win));
  vi.doMock("@tauri-apps/api/window", () => tauriMocks.window(win));
  vi.doMock("@tauri-apps/api/webviewWindow", () => tauriMocks.webviewWindow(win));
  if (!options.keepDisk && !extra) backend.reset();
  backend.failNext.clear();
  win.reset(options.label ?? "main");
  if (extra) {
    if ([...fakeWindows.values()].some((w) => w !== win && w.label === win.label && !w.destroyed)) {
      throw new Error(`bootApp: a window labelled ${win.label} is already running`);
    }
    fakeWindows.set(win.label, win);
    backend.windows.add(win.label);
    // The other window keeps its editor; this one gets a root of its own.
    document.getElementById("editor-root")?.removeAttribute("id");
    document.body.insertAdjacentHTML("beforeend", '<div id="editor-root"></div>');
  } else {
    backend.calls = [];
    // A new app process: drafts from before it are not this run's (MERGE-1).
    backend.runStartedAt = Date.now();
    dialogs.reset();
    fakeWindows.clear();
    fakeWindows.set(win.label, win);
    backend.windows.clear();
    backend.windows.add(win.label);
    backend.closingWindows.clear();
    backend.openPaths.clear();
    localStorage.clear();
    document.body.innerHTML = '<div id="editor-root"></div>';
  }
  dialogs.askAnswers = options.askAnswers ?? [];
  if (options.settings) localStorage.setItem("notepadly.settings.v1", JSON.stringify(options.settings));
  if (options.recent) localStorage.setItem("notepadly.recent.v1", JSON.stringify(options.recent));

  const store = await import("../state/store");
  const { actions } = await import("../state/actions");
  const loader = await import("../lib/loader");
  if (!extra) previousLoader = loader;
  const { engine } = await import("../editor");
  await actions.init();

  const state = () => store.useApp.getState();
  const tab = (id = state().activeId) => store.getTab(id)!;
  const tabByName = (name: string) => state().tabs.find((t) => t.title === name)!;

  return {
    /** This app's window. */
    win,
    actions,
    loader,
    engine,
    store,
    state,
    tab,
    tabByName,
    /** Types at the end of the active document, as the user would. */
    type(text: string) {
      const id = state().activeId;
      engine.restore(id, { anchor: engine.length(id), head: engine.length(id), scrollTop: 0 });
      engine.insertText(text);
    },
    text: (id = state().activeId) => engine.getText(id),
    /** Answers the "save changes?" dialog once it shows up. */
    async answerClose(answer: "save" | "discard" | "cancel") {
      await waitFor(() => state().dialog?.kind === "confirm-close");
      const dialog = state().dialog;
      if (dialog?.kind === "confirm-close") dialog.resolve(answer);
    },
    message: () => {
      const dialog = state().dialog;
      return dialog?.kind === "message" ? dialog : null;
    },
  };
}

export type App = Awaited<ReturnType<typeof bootApp>>;

/** A FakeWindow for a second app booted with `bootApp({ window })`. */
export const newFakeWindow = () => new FakeWindow();

/** Polls until the condition holds; fails the test after `timeout` ms. */
export async function waitFor(condition: () => boolean, timeout = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets queued promise chains and short timers run. */
export const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
