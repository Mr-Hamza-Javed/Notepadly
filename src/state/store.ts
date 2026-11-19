// The zustand store and narrow selector hooks. Behaviour lives in actions.ts.
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { CursorInfo, FormatContext } from "../editor/api";
import type { AppState, Dialog, PageSetup, Settings, TabMeta } from "./types";
import {
  UNTITLED,
  computeDark,
  defaultModeFor,
  mergeRecent,
  mergeSettings,
  sanitizePageSetup,
  sanitizeRecent,
  sanitizeSettings,
} from "./logic";

const KEY_SETTINGS = "notepadly.settings.v1";
const KEY_RECENT = "notepadly.recent.v1";
const KEY_PAGE_SETUP = "notepadly.pageSetup.v1";
const PERSIST_DEBOUNCE_MS = 400;

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the app keeps working on in-memory values.
  }
}

export function newTabId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function makeUntitledTab(formatting: boolean): TabMeta {
  return {
    id: newTabId(),
    path: null,
    title: UNTITLED,
    dirty: false,
    mode: defaultModeFor(null, formatting),
    eol: "CRLF",
    encoding: "utf-8",
    stamp: null,
    loadedOffset: 0,
    fullyLoaded: true,
    tailChars: null,
    externalChange: null,
    hibernated: false,
  };
}

const darkQuery =
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

const initialSettings = sanitizeSettings(readJson(KEY_SETTINGS));
const initialTab = makeUntitledTab(initialSettings.formatting);

export const INITIAL_CURSOR: CursorInfo = { line: 1, col: 1, chars: 0, selected: 0, canUndo: false, canRedo: false };
export const INITIAL_FORMAT: FormatContext = {
  block: "body",
  list: "none",
  bold: false,
  italic: false,
  strike: false,
  link: false,
  inTable: false,
};

export const useApp = create<AppState>()(() => ({
  tabs: [initialTab],
  activeId: initialTab.id,
  view: "editor",
  settings: initialSettings,
  recent: sanitizeRecent(readJson(KEY_RECENT)),
  cursor: INITIAL_CURSOR,
  format: INITIAL_FORMAT,
  find: { open: false, replace: false },
  dialog: null,
  pageSetup: sanitizePageSetup(readJson(KEY_PAGE_SETUP)),
  dark: computeDark(initialSettings.theme, darkQuery?.matches ?? false),
}));

// ---- Theme ----------------------------------------------------------------

function applyTheme(): void {
  const { settings, dark: previous } = useApp.getState();
  const dark = computeDark(settings.theme, darkQuery?.matches ?? false);
  if (dark !== previous) useApp.setState({ dark });
  if (typeof document !== "undefined") document.documentElement.dataset.theme = dark ? "dark" : "light";
}

applyTheme();
darkQuery?.addEventListener("change", applyTheme);

// ---- Debounced localStorage writes ----------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | null = null;
type SharedPrefs = Pick<AppState, "settings" | "recent" | "pageSetup">;
let written: SharedPrefs = useApp.getState();
/** Set while values written by another window are taken in, so they are not written back. */
let adopting = false;

/**
 * Other windows share these keys (H12). Each write merges this window's own
 * changes into what is stored now, so it never wipes out another window's change.
 */
export function flushPersistedPrefs(): void {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = null;
  let { settings, recent, pageSetup } = useApp.getState();
  if (settings !== written.settings) {
    settings = mergeSettings(sanitizeSettings(readJson(KEY_SETTINGS) ?? written.settings), written.settings, settings);
    writeJson(KEY_SETTINGS, settings);
  }
  if (recent !== written.recent) {
    recent = mergeRecent(sanitizeRecent(readJson(KEY_RECENT) ?? written.recent), written.recent, recent);
    writeJson(KEY_RECENT, recent);
  }
  if (pageSetup !== written.pageSetup) writeJson(KEY_PAGE_SETUP, pageSetup);
  written = { settings, recent, pageSetup };
  adoptPrefs(written);
  written = pickShared(useApp.getState());
}

type PrefsListener = (previous: Settings, next: Settings) => void;
const prefsListeners: PrefsListener[] = [];

/** Runs when settings changed by another window were taken in; actions.ts applies them. */
export function onSharedSettings(listener: PrefsListener): void {
  prefsListeners.push(listener);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pickShared = ({ settings, recent, pageSetup }: AppState): SharedPrefs => ({ settings, recent, pageSetup });

function adoptPrefs(next: SharedPrefs): void {
  const state = useApp.getState();
  const patch: Partial<SharedPrefs> = {};
  if (!same(next.settings, state.settings)) patch.settings = next.settings;
  if (!same(next.recent, state.recent)) patch.recent = next.recent;
  if (!same(next.pageSetup, state.pageSetup)) patch.pageSetup = next.pageSetup;
  if (Object.keys(patch).length === 0) return;
  adopting = true;
  try {
    useApp.setState(patch);
  } finally {
    adopting = false;
  }
  if (patch.settings) for (const listener of prefsListeners) listener(state.settings, next.settings);
}

/** Another window wrote the shared preferences: take them in (H12). */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== KEY_SETTINGS && event.key !== KEY_RECENT && event.key !== KEY_PAGE_SETUP) {
    return;
  }
  // This window's own unsaved changes go on top of what the other window stored.
  if (persistTimer !== null) flushPersistedPrefs();
  written = {
    settings: sanitizeSettings(readJson(KEY_SETTINGS) ?? written.settings),
    recent: sanitizeRecent(readJson(KEY_RECENT) ?? written.recent),
    pageSetup: sanitizePageSetup(readJson(KEY_PAGE_SETUP) ?? written.pageSetup),
  };
  adoptPrefs(written);
  written = pickShared(useApp.getState());
}

useApp.subscribe((state, previous) => {
  if (state.settings.theme !== previous.settings.theme) applyTheme();
  if (adopting) return;
  const changed =
    state.settings !== previous.settings ||
    state.recent !== previous.recent ||
    state.pageSetup !== previous.pageSetup;
  if (changed && persistTimer === null) persistTimer = setTimeout(flushPersistedPrefs, PERSIST_DEBOUNCE_MS);
});

if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("pagehide", flushPersistedPrefs);
  window.addEventListener("storage", onStorage);
}

// ---- Non-hook accessors ---------------------------------------------------

export const getTab = (id: string): TabMeta | undefined => useApp.getState().tabs.find((t) => t.id === id);
export const getActiveTab = (): TabMeta | undefined => getTab(useApp.getState().activeId);

/** Replaces one tab only when a field really changes, so subscribers stay quiet. */
export function patchTab(id: string, patch: Partial<TabMeta>): void {
  useApp.setState((state) => {
    const index = state.tabs.findIndex((t) => t.id === id);
    if (index < 0) return state;
    const tab = state.tabs[index];
    const changed = (Object.keys(patch) as (keyof TabMeta)[]).some((k) => tab[k] !== patch[k]);
    if (!changed) return state;
    const tabs = state.tabs.slice();
    tabs[index] = { ...tab, ...patch };
    return { tabs };
  });
}

// ---- Dialog queue ------------------------------------------------------------

/**
 * Dialogs waiting their turn, as Windows stacks modal boxes (BUGS.md UI-9): a
 * message never replaces what is on screen, so a second error does not hide the
 * first and a half-typed Go to / Link / Page setup survives a background failure.
 * Lives outside AppState because only the dialog plumbing cares.
 */
let dialogQueue: Dialog[] = [];

/** Dialogs still waiting behind the one on screen (for tests). */
export const queuedDialogs = (): readonly Dialog[] => dialogQueue;

/** Removes the dialog on screen and shows the next waiting one, if any. */
export function nextDialog(): void {
  const next = dialogQueue.shift() ?? null;
  useApp.setState({ dialog: next });
}

/** Drops the dialog on screen and everything waiting (a window going to the background). */
export function clearDialogs(): void {
  dialogQueue = [];
  useApp.setState({ dialog: null });
}

/**
 * Puts a dialog the user asked for (or a "save changes?" question) on screen now.
 * A message it covers goes back to the front of the queue and returns afterwards.
 */
export function pushDialog(dialog: Dialog): void {
  const current = useApp.getState().dialog;
  if (current?.kind === "message") dialogQueue.unshift(current);
  useApp.setState({ dialog });
}

export function showMessage(title: string, body: string): void {
  const message: Dialog = { kind: "message", title, body };
  const { dialog } = useApp.getState();
  if (!dialog) {
    useApp.setState({ dialog: message });
    return;
  }
  dialogQueue.push(message);
  // A "save changes?" dialog must still be answered, or whoever is waiting on it
  // (closing a tab or the window) waits forever (BUGS.md C4): answer it as Cancel,
  // which brings up the message.
  if (dialog.kind === "confirm-close") dialog.resolve("cancel");
}

// ---- Load progress (status bar) --------------------------------------------

/**
 * Lives outside AppState because the contract in types.ts has no field for it
 * and only the status bar cares.
 */
export interface LoadProgress {
  tabId: string;
  loaded: number;
  total: number;
}

const useLoadStore = create<{ progress: LoadProgress | null }>()(() => ({ progress: null }));

export function setLoadProgress(progress: LoadProgress | null): void {
  useLoadStore.setState({ progress });
}

/** Whole-file load progress of the active tab; null when nothing is loading. */
export function useLoadProgress(): LoadProgress | null {
  const activeId = useApp((s) => s.activeId);
  return useLoadStore((s) => (s.progress?.tabId === activeId ? s.progress : null));
}

// ---- Selector hooks --------------------------------------------------------

export const useActiveTab = (): TabMeta | undefined => useApp((s) => s.tabs.find((t) => t.id === s.activeId));
export const useTab = (id: string): TabMeta | undefined => useApp((s) => s.tabs.find((t) => t.id === id));
export const useTabIds = (): string[] => useApp(useShallow((s) => s.tabs.map((t) => t.id)));
export const useActiveId = (): string => useApp((s) => s.activeId);
export const useIsActive = (id: string): boolean => useApp((s) => s.activeId === id);
export const useActiveMode = () => useApp((s) => s.tabs.find((t) => t.id === s.activeId)?.mode ?? "plain");
export const useView = (): AppState["view"] => useApp((s) => s.view);
export const useSettings = (): Settings => useApp((s) => s.settings);
export const useSetting = <K extends keyof Settings>(key: K): Settings[K] => useApp((s) => s.settings[key]);
export const useRecent = (): string[] => useApp((s) => s.recent);
export const useCursor = (): CursorInfo => useApp((s) => s.cursor);
export const useFormatContext = (): FormatContext => useApp((s) => s.format);
export const useFindState = (): AppState["find"] => useApp((s) => s.find);
export const useDialog = (): Dialog | null => useApp((s) => s.dialog);
export const usePageSetup = (): PageSetup => useApp((s) => s.pageSetup);
export const useDark = (): boolean => useApp((s) => s.dark);
