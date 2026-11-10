// Application behaviour. Components call `actions`; the engine calls `editorHost`.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { engine } from "../editor";
import type { CursorInfo, EditorConfig, EditorEngine, EditorHost, FormatContext, FormatMode } from "../editor/api";
import { ipc, OPEN_PATHS_EVENT, type Encoding, type Eol } from "../lib/ipc";
import * as loader from "../lib/loader";
import { installShortcuts } from "../lib/shortcuts";
import {
  clampZoom,
  classifyHref,
  defaultModeFor,
  deriveTitle,
  dirOf,
  fileNameOf,
  firstLineOf,
  fontStack,
  fontWeightOf,
  formatDateTime,
  isMarkdownPath,
  modeAfterSave,
  moveItem,
  neighbourAfterClose,
  openFilters,
  parseSession,
  pathsEqual,
  pushRecent,
  resolveRelative,
  saveFilters,
  suggestedFileName,
  tabFromSession,
  withDefaultExtension,
  wrapIndex,
} from "./logic";
import {
  flushPersistedPrefs,
  getActiveTab,
  getTab,
  makeUntitledTab,
  newTabId,
  patchTab,
  showMessage,
  useApp,
} from "./store";
import type { Dialog, Settings, TabMeta } from "./types";

const TITLE_DEBOUNCE_MS = 250;
const TITLE_MAX_DOC_CHARS = 256 * 1024;
const MOUNT_WAIT_MS = 1500;
const MOUNT_SELECTOR =
  "#editor-root,[data-editor-root],#editor-host,[data-editor-host],#editor,.editor-root,.editor-host";

const state = () => useApp.getState();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

let isMainWindow = false;

// ---- Engine host and mounting ------------------------------------------------

export function currentEditorConfig(): EditorConfig {
  const s = state().settings;
  return {
    wordWrap: s.wordWrap,
    zoom: s.zoom,
    fontFamily: fontStack(s.fontFamily),
    fontWeight: fontWeightOf(s.fontStyle),
    fontSizePt: s.fontSizePt,
    spellcheck: s.spellcheck,
    autocorrect: s.autocorrect,
  };
}

const titleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** First line without flattening a big document; see the engine note in firstLine. */
function readFirstLine(id: string): string | null {
  const withFirstLine = engine as EditorEngine & { firstLine?: (tabId: string) => string };
  if (withFirstLine.firstLine) return withFirstLine.firstLine(id);
  if (engine.length(id) > TITLE_MAX_DOC_CHARS) return null;
  return firstLineOf(engine.getText(id));
}

function scheduleTitle(id: string): void {
  if (getTab(id)?.path !== null) return;
  const pending = titleTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  titleTimers.set(
    id,
    setTimeout(() => {
      titleTimers.delete(id);
      const tab = getTab(id);
      if (!tab || tab.path !== null || !engine.hasDoc(id)) return;
      const line = readFirstLine(id);
      if (line === null) return;
      patchTab(id, { title: deriveTitle(line) });
      loader.scheduleSessionWrite();
    }, TITLE_DEBOUNCE_MS),
  );
}

const sameCursor = (a: CursorInfo, b: CursorInfo) =>
  a.line === b.line &&
  a.col === b.col &&
  a.chars === b.chars &&
  a.selected === b.selected &&
  a.canUndo === b.canUndo &&
  a.canRedo === b.canRedo;

const sameFormat = (a: FormatContext, b: FormatContext) =>
  a.block === b.block &&
  a.list === b.list &&
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.strike === b.strike &&
  a.link === b.link &&
  a.inTable === b.inTable;

async function openExternal(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export const editorHost: EditorHost = {
  onDirtyChange: (id, dirty) => {
    loader.noteDirty(id, dirty);
    loader.scheduleSessionWrite();
  },
  onDocChange: (id) => {
    loader.noteEdit(id);
    scheduleTitle(id);
  },
  onCursor: (id, info) => {
    const s = state();
    if (id === s.activeId && !sameCursor(s.cursor, info)) useApp.setState({ cursor: info });
  },
  onFormatContext: (id, ctx) => {
    const s = state();
    if (id === s.activeId && !sameFormat(s.format, ctx)) useApp.setState({ format: ctx });
  },
  onNearEnd: loader.onNearEnd,
  onZoomDelta: (delta) => actions.zoomBy(delta),
  openLink: (href) => {
    const base = editorHost.baseDir(state().activeId);
    const target = classifyHref(href, base);
    if (target.kind === "web") openExternal(target.url).catch(reportError("Could not open link"));
    else if (target.kind === "file") void actions.openPaths([target.path]);
  },
  baseDir: (id) => {
    const path = getTab(id)?.path;
    return path ? dirOf(path) : null;
  },
};

function reportError(title: string) {
  return (error: unknown) => showMessage(title, errorText(error));
}

let mountedParent: HTMLElement | null = null;
let initFinished = false;
let notifyMounted: () => void = () => {};
const mounted = new Promise<void>((resolve) => {
  notifyMounted = resolve;
});

/** Attaches the single editor view. Call from the editor component; safe in StrictMode. */
export function mountEditor(parent: HTMLElement): void {
  if (mountedParent === parent) return;
  mountedParent = parent;
  engine.mount(parent, editorHost, currentEditorConfig());
  notifyMounted();
  if (initFinished && engine.hasDoc(state().activeId)) engine.activate(state().activeId);
}

function waitForEditorParent(): Promise<void> {
  if (mountedParent) return Promise.resolve();
  const find = () => {
    const parent = document.querySelector<HTMLElement>(MOUNT_SELECTOR);
    if (parent) mountEditor(parent);
    return !!parent;
  };
  if (find()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => find());
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      console.warn("Notepadly: no editor parent was mounted; continuing without one.");
      finish();
    }, MOUNT_WAIT_MS);
    const finish = () => {
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    };
    void mounted.then(finish);
  });
}

// ---- Dialogs -----------------------------------------------------------------

function askConfirmClose(tabId: string): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    useApp.setState({
      dialog: {
        kind: "confirm-close",
        tabId,
        resolve: (answer) => {
          useApp.setState({ dialog: null });
          resolve(answer);
        },
      },
    });
  });
}

function closeDialog(): void {
  const { dialog } = state();
  if (dialog?.kind === "confirm-close") dialog.resolve("cancel");
  else if (dialog) useApp.setState({ dialog: null });
}

// ---- Activation --------------------------------------------------------------

let activationToken = 0;

async function activate(id: string): Promise<void> {
  const s = state();
  if (!getTab(id)) return;
  if (s.activeId !== id) loader.touchTab(s.activeId);
  useApp.setState({ activeId: id, view: "editor" });
  const token = ++activationToken;
  if (!engine.hasDoc(id)) await loader.materialiseOrFlag(id);
  if (token !== activationToken || !engine.hasDoc(id)) return;
  engine.activate(id);
  engine.focus();
  loader.scheduleSessionWrite();
}

function addTab(tab: TabMeta): void {
  useApp.setState((s) => ({ tabs: [...s.tabs, tab] }));
  loader.scheduleSessionWrite();
}

function newTab(): Promise<void> {
  const tab = makeUntitledTab(state().settings.formatting);
  engine.createDoc(tab.id, "", tab.mode);
  addTab(tab);
  return activate(tab.id);
}

// ---- Opening -----------------------------------------------------------------

function addRecent(path: string): void {
  if (state().settings.recentFiles) useApp.setState((s) => ({ recent: pushRecent(s.recent, path) }));
}

function isPristine(tab: TabMeta | undefined): tab is TabMeta {
  return !!tab && tab.path === null && !tab.dirty && (!engine.hasDoc(tab.id) || engine.length(tab.id) === 0);
}

const findOpen = (path: string) => state().tabs.find((t) => pathsEqual(t.path, path));

function dedupePaths(paths: string[]): string[] {
  return paths.filter((path, index) => paths.findIndex((other) => pathsEqual(other, path)) === index);
}

/** Opens in this window. Only the last file is read now; the others load on first activate. */
async function openHere(input: string[]): Promise<void> {
  const paths = dedupePaths(input);
  if (paths.length === 0) return;
  const pristine = getActiveTab();
  const stats = await Promise.all(paths.map((p) => ipc.stat(p).catch(() => null)));
  const failed: string[] = [];
  let target: string | null = null;
  const created: string[] = [];

  paths.forEach((path, index) => {
    const existing = findOpen(path);
    if (existing) {
      target = existing.id;
      addRecent(path);
      return;
    }
    const stamp = stats[index];
    if (!stamp) {
      failed.push(path);
      return;
    }
    const tab: TabMeta = {
      id: newTabId(),
      path,
      title: fileNameOf(path),
      dirty: false,
      mode: defaultModeFor(path, state().settings.formatting),
      eol: "CRLF",
      encoding: "utf-8",
      stamp,
      loadedOffset: 0,
      fullyLoaded: false,
      totalChars: null,
      externalChange: null,
      hibernated: true,
    };
    addTab(tab);
    created.push(tab.id);
    target = tab.id;
    addRecent(path);
  });

  if (target !== null) {
    const targetId: string = target;
    try {
      await loader.materialise(targetId);
      loader.afterFirstLoad(targetId);
      await activate(targetId);
      if (created.length > 0 && isPristine(pristine) && pristine.id !== targetId) removeFromList(pristine.id);
    } catch (error) {
      if (created.includes(targetId)) removeFromList(targetId);
      failed.push(`${fileNameOf(paths[paths.length - 1])}: ${errorText(error)}`);
    }
  }

  if (failed.length > 0) {
    useApp.setState((s) => ({ recent: s.recent.filter((r) => !failed.some((f) => pathsEqual(f, r))) }));
    showMessage("Could not open file", failed.join("\n"));
  }
}

async function openPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  if (state().settings.openFilesIn !== "window") return openHere(paths);
  const fresh = dedupePaths(paths).filter((p) => !findOpen(p));
  const open = paths.map(findOpen).filter((t): t is TabMeta => !!t);
  if (open.length > 0) await activate(open[open.length - 1].id);
  if (fresh.length > 0) await ipc.newWindow(fresh).catch(reportError("Could not open a new window"));
}

async function openDialog(): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, filters: openFilters() });
  if (picked) await openPaths(picked);
}

// ---- Saving ------------------------------------------------------------------

function applyMode(id: string, mode: FormatMode): void {
  if (engine.hasDoc(id)) engine.setMode(id, mode);
  patchTab(id, { mode });
  loader.scheduleSessionWrite();
}

async function writeAndReport(id: string, path: string): Promise<boolean> {
  const result = await loader.writeTab(id, path);
  if (result.ok) {
    addRecent(path);
    return true;
  }
  if (result.stale) {
    patchTab(id, { externalChange: "modified" });
    showMessage(
      "File changed on disk",
      "This file was changed by another program, so it was not saved. Reload it to see those changes, or use Save as to keep your text under another name.",
    );
  } else {
    showMessage("Could not save file", result.message);
  }
  return false;
}

async function saveAs(tabId?: string): Promise<boolean> {
  const id = tabId ?? state().activeId;
  const tab = getTab(id);
  if (!tab) return false;
  const { save: pickPath } = await import("@tauri-apps/plugin-dialog");
  const name = suggestedFileName(tab);
  const dir = tab.path ? dirOf(tab.path) : null;
  const chosen = await pickPath({
    defaultPath: dir ? resolveRelative(dir, name) : name,
    filters: saveFilters(tab.mode),
  });
  if (!chosen) return false;
  const path = withDefaultExtension(chosen, tab.mode);
  const movesFile = !pathsEqual(path, tab.path);
  if (movesFile) {
    try {
      await loader.ensureFullyLoaded(id);
    } catch (error) {
      showMessage("Could not save file", errorText(error));
      return false;
    }
  }
  if (!(await writeAndReport(id, path))) return false;
  if (movesFile) {
    const current = getTab(id);
    if (current) applyMode(id, modeAfterSave(current.mode, path, state().settings.formatting));
  }
  return true;
}

async function save(tabId?: string): Promise<boolean> {
  const id = tabId ?? state().activeId;
  const tab = getTab(id);
  if (!tab) return false;
  if (!tab.path) return saveAs(id);
  if (!tab.dirty) return true;
  return writeAndReport(id, tab.path);
}

async function saveAll(): Promise<void> {
  for (const { id } of state().tabs.filter((t) => t.dirty)) {
    const tab = getTab(id);
    if (!tab?.dirty) continue;
    if (!tab.path) await activate(id);
    await save(id);
  }
}

// ---- Closing -----------------------------------------------------------------

/** Answers for one dirty tab. False means the user wants to stay. */
async function resolveDirtyTab(id: string): Promise<boolean> {
  if (state().dialog?.kind === "confirm-close") return false;
  await activate(id);
  const answer = await askConfirmClose(id);
  if (answer === "cancel") return false;
  return answer === "save" ? save(id) : true;
}

function removeFromList(id: string): void {
  useApp.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }));
  if (engine.hasDoc(id)) engine.dropDoc(id);
  loader.disposeTab(id);
  const pending = titleTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  titleTimers.delete(id);
  loader.scheduleSessionWrite();
}

async function removeTab(id: string): Promise<void> {
  const { tabs, activeId } = state();
  if (tabs.length === 1) {
    // Like Notepad, closing the only tab closes the window. A fresh tab first
    // keeps the "there is always a tab" invariant if the close is refused.
    await newTab();
    removeFromList(id);
    await closeWindow();
    return;
  }
  if (activeId === id) {
    const next = neighbourAfterClose(tabs.map((t) => t.id), id);
    if (next) await activate(next);
  }
  removeFromList(id);
}

const closing = new Map<string, Promise<boolean>>();

async function doCloseTab(id: string): Promise<boolean> {
  if (!getTab(id)) return true;
  await loader.settleTabIo(id);
  const tab = getTab(id);
  if (!tab) return true;
  if (tab.dirty && !(await resolveDirtyTab(id))) return false;
  await removeTab(id);
  return true;
}

function closeTab(id: string): Promise<boolean> {
  const running = closing.get(id);
  if (running) return running;
  const run = doCloseTab(id).finally(() => closing.delete(id));
  closing.set(id, run);
  return run;
}

async function closeMany(ids: string[]): Promise<void> {
  for (const id of ids) if (!(await closeTab(id))) return;
}

let closeInProgress = false;

/** Decides whether this window may go. True means every tab has been answered for. */
async function prepareWindowClose(): Promise<boolean> {
  if (closeInProgress) return false;
  closeInProgress = true;
  try {
    flushPersistedPrefs();
    if (isMainWindow && state().settings.startup === "continue") {
      try {
        await loader.flushPersistence();
        return true;
      } catch (error) {
        // Text that cannot be stored as a draft must not vanish: ask instead.
        console.error("Notepadly: could not store drafts", error);
      }
    }
    for (const { id } of state().tabs.filter((t) => t.dirty)) {
      if (getTab(id)?.dirty && !(await resolveDirtyTab(id))) return false;
    }
    if (isMainWindow) await loader.discardCurrentSession().catch(() => {});
    return true;
  } finally {
    closeInProgress = false;
  }
}

/**
 * Puts the window into the state a fresh launch would show, so waking it from the
 * background looks exactly like starting the app. prepareWindowClose has already
 * stored or resolved every tab.
 */
async function resetForBackground(): Promise<void> {
  useApp.setState({ view: "editor", dialog: null, find: { open: false, replace: false } });
  if (isMainWindow && state().settings.startup === "continue") return; // the session is what comes back
  const old = state().tabs.map((t) => t.id);
  await newTab();
  old.forEach(removeFromList);
}

async function closeWindow(): Promise<void> {
  await getCurrentWindow().close();
}

async function exit(): Promise<void> {
  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const self = getCurrentWindow().label;
    for (const win of await getAllWebviewWindows()) if (win.label !== self) await win.close();
  } catch (error) {
    console.error("Notepadly: could not close other windows", error);
  }
  await closeWindow();
}

// ---- Settings ----------------------------------------------------------------

function syncWindowTheme(): void {
  const { theme } = state().settings;
  getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {});
}

function applyFormattingSetting(formatting: boolean): void {
  for (const tab of state().tabs) {
    if (tab.path !== null && !isMarkdownPath(tab.path)) continue;
    if (formatting ? tab.mode === "plain" : tab.mode !== "plain") {
      applyMode(tab.id, formatting ? "formatted" : "plain");
    }
  }
}

function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  useApp.setState((s) => ({ settings: { ...s.settings, [key]: value } }));
  switch (key) {
    case "wordWrap":
    case "spellcheck":
    case "autocorrect":
    case "zoom":
    case "fontFamily":
    case "fontStyle":
    case "fontSizePt":
      engine.setConfig(currentEditorConfig());
      break;
    case "theme":
      syncWindowTheme();
      break;
    case "formatting":
      applyFormattingSetting(value as boolean);
      break;
    case "recentFiles":
      if (!value) useApp.setState({ recent: [] });
      break;
    case "startup":
      loader.setPersistence(isMainWindow && value === "continue");
      break;
    case "autoUpdate":
      ipc.updateConfigure(value as boolean).catch(() => {});
      break;
  }
}

async function ensureFullyLoaded(id: string): Promise<void> {
  try {
    await loader.ensureFullyLoaded(id);
  } catch (error) {
    showMessage("Could not load the whole file", errorText(error));
    throw error;
  }
}

/** A partial tab's tail keeps its old bytes, so a format change needs the whole file. */
async function changeFileFormat(patch: { eol: Eol } | { encoding: Encoding }): Promise<void> {
  const id = state().activeId;
  const tab = getTab(id);
  if (!tab) return;
  if (("eol" in patch && patch.eol === tab.eol) || ("encoding" in patch && patch.encoding === tab.encoding)) return;
  try {
    await ensureFullyLoaded(id);
  } catch {
    return;
  }
  patchTab(id, patch);
  loader.forceDirty(id);
  loader.scheduleSessionWrite();
}

// ---- Startup -----------------------------------------------------------------

function wireWindowEvents(): void {
  const win = getCurrentWindow();
  const warn = (what: string) => (error: unknown) => console.error(`Notepadly: ${what}`, error);

  // Rust sends this with emit_to(webview_window(label)), which only reaches
  // listeners registered with that exact target kind.
  getCurrentWebviewWindow()
    .listen<string[]>(OPEN_PATHS_EVENT, (event) => void openPaths(event.payload))
    .catch(warn("open-paths listener failed"));

  getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === "drop") void openPaths(event.payload.paths);
    })
    .catch(warn("drag and drop listener failed"));

  win
    .onCloseRequested(async (event) => {
      if (!(await prepareWindowClose())) {
        event.preventDefault();
        return;
      }
      // Like Notepad: the last window hides and waits instead of quitting.
      if (!state().settings.background || !(await ipc.isLastWindow().catch(() => false))) return;
      event.preventDefault();
      await resetForBackground();
      await ipc.enterBackground().catch(async (error) => {
        console.error("Notepadly: could not go to the background", error);
        await win.destroy();
      });
    })
    .catch(warn("close listener failed"));

  win.onFocusChanged(({ payload }) => loader.setWindowFocused(payload)).catch(warn("focus listener failed"));
  window.addEventListener("focus", () => loader.setWindowFocused(true));
  window.addEventListener("blur", () => loader.setWindowFocused(false));
  win
    .isFocused()
    .then((focused) => loader.setWindowFocused(focused))
    .catch(() => loader.setWindowFocused(document.hasFocus()));
}

async function restoreSession(raw: string | null): Promise<boolean> {
  const session = parseSession(raw);
  if (!session || session.tabs.length === 0) return false;
  session.tabs.forEach(loader.registerRestored);
  useApp.setState({ tabs: session.tabs.map(tabFromSession), activeId: session.activeId });
  await loader.materialiseOrFlag(session.activeId);
  return true;
}

async function runInit(): Promise<void> {
  isMainWindow = getCurrentWindow().label === "main";
  installShortcuts();
  syncWindowTheme();
  await waitForEditorParent();

  const continueSession = isMainWindow && state().settings.startup === "continue";
  const [rawSession, pending] = await Promise.all([
    isMainWindow ? ipc.sessionRead().catch(() => null) : Promise.resolve(null),
    ipc.takePendingPaths().catch(() => [] as string[]),
  ]);

  let restored = false;
  if (continueSession) restored = await restoreSession(rawSession);
  else if (isMainWindow && rawSession) loader.discardSession(parseSession(rawSession)).catch(() => {});

  const { activeId } = state();
  if (!restored) engine.createDoc(activeId, "", getTab(activeId)?.mode ?? "plain");
  if (engine.hasDoc(activeId)) {
    engine.activate(activeId);
    engine.focus();
  }
  loader.setPersistence(continueSession);
  initFinished = true;

  await openHere(pending);
  wireWindowEvents();
  loader.startHibernation();
  // The checker thread waits for this before it ever contacts GitHub.
  ipc.updateConfigure(state().settings.autoUpdate).catch(() => {});
}

let initRun: Promise<void> | null = null;

// ---- Public API --------------------------------------------------------------

export const actions = {
  init: (): Promise<void> => (initRun ??= runInit()),

  newTab,
  openDialog,
  openPaths,
  openRecent: (path: string) => openPaths([path]),
  clearRecent: () => useApp.setState({ recent: [] }),

  save,
  saveAs,
  saveAll,

  closeTab,
  closeOthers: (id: string) => closeMany(state().tabs.filter((t) => t.id !== id).map((t) => t.id)),
  closeToRight: (id: string) => {
    const ids = state().tabs.map((t) => t.id);
    return closeMany(ids.slice(ids.indexOf(id) + 1));
  },
  closeWindow,
  exit,

  activate,
  moveTab: (fromIndex: number, toIndex: number) => {
    useApp.setState((s) => ({ tabs: moveItem(s.tabs, fromIndex, toIndex) }));
    loader.scheduleSessionWrite();
  },
  nextTab: (dir: 1 | -1) => {
    const { tabs, activeId } = state();
    const index = tabs.findIndex((t) => t.id === activeId);
    return activate(tabs[wrapIndex(index + dir, tabs.length)].id);
  },
  newWindow: () => ipc.newWindow([]).catch(reportError("Could not open a new window")),

  copyPath: (id: string) => {
    const path = getTab(id)?.path;
    if (path) navigator.clipboard.writeText(path).catch(reportError("Could not copy path"));
  },
  revealTab: (id: string) => {
    const path = getTab(id)?.path;
    if (path) ipc.revealInExplorer(path).catch(reportError("Could not open Explorer"));
  },
  reloadTab: (id: string) => loader.reloadFromDisk(id).catch(reportError("Could not reload file")),
  keepMine: (id: string) => loader.keepMine(id),

  setMode: applyMode,
  toggleSyntax: () => {
    const tab = getActiveTab();
    if (tab && tab.mode !== "plain") applyMode(tab.id, tab.mode === "formatted" ? "syntax" : "formatted");
  },

  setSetting,
  zoomBy: (delta: number) => setSetting("zoom", clampZoom(state().settings.zoom + delta)),
  zoomReset: () => setSetting("zoom", 100),

  setEol: (eol: Eol) => changeFileFormat({ eol }),
  setEncoding: (encoding: Encoding) => changeFileFormat({ encoding }),

  openFind: (replace: boolean) => {
    useApp.setState({ find: { open: true, replace }, view: "editor" });
    ensureFullyLoaded(state().activeId).catch(() => {});
  },
  closeFind: () => {
    useApp.setState({ find: { open: false, replace: false } });
    engine.clearFind();
    engine.focus();
  },
  ensureFullyLoaded,

  insertDateTime: () => engine.insertText(formatDateTime(new Date())),
  searchWeb: () => {
    const selection = engine.selectionText().trim();
    if (!selection) return;
    openExternal(`https://www.bing.com/search?q=${encodeURIComponent(selection)}`).catch(
      reportError("Could not open the browser"),
    );
  },
  print: async () => {
    try {
      const { printTab } = await import("../lib/print");
      await printTab(state().activeId);
    } catch (error) {
      showMessage("Could not print", errorText(error));
    }
  },

  showDialog: (dialog: Dialog) => {
    if (state().dialog?.kind === "confirm-close") closeDialog();
    useApp.setState({ dialog });
  },
  closeDialog,
  openSettings: () => useApp.setState({ view: "settings" }),
  openHelp: () => useApp.setState({ view: "help" }),
  closeSettings: () => {
    useApp.setState({ view: "editor" });
    engine.focus();
  },

  applyLink: (text: string, url: string) => {
    const target = /\s/.test(url) ? `<${url}>` : url;
    engine.insertText(`[${text || url}](${target})`);
    closeDialog();
    engine.focus();
  },
};
