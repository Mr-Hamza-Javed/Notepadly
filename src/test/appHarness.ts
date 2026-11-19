// Boots the real app modules (store, actions, loader, engine) against the fake
// Tauri backend. The test file must mock the Tauri modules with `tauriMocks`.
import "./dom";
import { vi } from "vitest";
import type { Settings } from "../state/types";
import { backend, dialogs, fakeWindow } from "./fakeTauri";

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
}

/** The loader of the previous boot, so its pending timers can be silenced like a closed process. */
let previousLoader: typeof import("../lib/loader") | null = null;

export async function bootApp(options: BootOptions = {}) {
  previousLoader?.setPersistence(false);
  vi.resetModules();
  if (!options.keepDisk) backend.reset();
  backend.calls = [];
  backend.failNext.clear();
  dialogs.reset();
  dialogs.askAnswers = options.askAnswers ?? [];
  fakeWindow.reset(options.label ?? "main");
  localStorage.clear();
  if (options.settings) localStorage.setItem("notepadly.settings.v1", JSON.stringify(options.settings));
  if (options.recent) localStorage.setItem("notepadly.recent.v1", JSON.stringify(options.recent));
  document.body.innerHTML = '<div id="editor-root"></div>';

  const store = await import("../state/store");
  const { actions } = await import("../state/actions");
  const loader = await import("../lib/loader");
  previousLoader = loader;
  const { engine } = await import("../editor");
  await actions.init();

  const state = () => store.useApp.getState();
  const tab = (id = state().activeId) => store.getTab(id)!;
  const tabByName = (name: string) => state().tabs.find((t) => t.title === name)!;

  return {
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
