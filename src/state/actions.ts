// Application behaviour. Components call `actions`; the engine calls `editorHost`.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { engine } from "../editor";
import type { CursorInfo, EditorConfig, EditorEngine, EditorHost, FormatContext, FormatMode } from "../editor/api";
import { ipc, OPEN_PATHS_EVENT, OPEN_PATHS_HERE_EVENT, type Encoding, type Eol, type WindowBoot } from "../lib/ipc";
import { dropIndexAt } from "../lib/tabDrag";
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
  type SessionFile,
  tabFromSession,
  chosenSavePath,
  wrapIndex,
} from "./logic";
import {
  flushPersistedPrefs,
  getActiveTab,
  getTab,
  makeUntitledTab,
  newTabId,
  onSharedSettings,
  patchTab,
  clearDialogs,
  nextDialog,
  pushDialog,
  showMessage,
  useApp,
} from "./store";
import type { Dialog, Settings, TabMeta } from "./types";
import { markAsleep } from "../lib/enterAnimation";

const TITLE_DEBOUNCE_MS = 250;
const TITLE_MAX_DOC_CHARS = 256 * 1024;
const MOUNT_WAIT_MS = 1500;
const MOUNT_SELECTOR =
  "#editor-root,[data-editor-root],#editor-host,[data-editor-host],#editor,.editor-root,.editor-host";

const state = () => useApp.getState();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** This window's label. "main" is the window the app starts with. */
let windowLabel = "main";
const isFirstWindow = () => windowLabel === "main";
/** Every window keeps its tabs as drafts and a session while this is on. */
const keepsSession = () => state().settings.startup === "continue";

/** Window events between windows of this app. */
const EXIT_EVENT = "exit-app";
const TAB_INCOMING_EVENT = "tab-incoming";
const TAB_RECEIVED_EVENT = "tab-received";
/** How long a tab being moved waits for the other window to take it. */
const MOVE_TIMEOUT_MS = 10_000;

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

function updateTitle(id: string): void {
  titleTimers.delete(id);
  const tab = getTab(id);
  if (!tab || tab.path !== null || !engine.hasDoc(id)) return;
  const line = readFirstLine(id);
  if (line === null) return;
  patchTab(id, { title: deriveTitle(line) });
  loader.scheduleSessionWrite();
}

function scheduleTitle(id: string): void {
  if (getTab(id)?.path !== null) return;
  const pending = titleTimers.get(id);
  if (pending !== undefined) clearTimeout(pending);
  titleTimers.set(id, setTimeout(() => updateTitle(id), TITLE_DEBOUNCE_MS));
}

/** Runs pending title updates now, so a session stored right away has the right names (BUGS.md T2). */
function flushTitles(): void {
  for (const [id, timer] of [...titleTimers]) {
    clearTimeout(timer);
    updateTitle(id);
  }
}

const sameCursor = (a: CursorInfo, b: CursorInfo) =>
  a.line === b.line &&
  a.col === b.col &&
  a.chars === b.chars &&
  a.selected === b.selected &&
  a.canUndo === b.canUndo &&
  a.canRedo === b.canRedo &&
  !!a.previewLimited === !!b.previewLimited;

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

/** PDFs, images and other non-text files a document links to; `classifyHref` decides which. */
async function openWithDefaultApp(path: string): Promise<void> {
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
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
    // A link opens next to the document it is in, whatever "Open files in" says (M10).
    else if (target.kind === "file") void openHere([target.path]);
    else if (target.kind === "external") openWithDefaultApp(target.path).catch(reportError("Could not open link"));
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
    const dialog: Dialog = {
      kind: "confirm-close",
      tabId,
      resolve: (answer) => {
        if (state().dialog === dialog) nextDialog();
        resolve(answer);
      },
    };
    pushDialog(dialog);
  });
}

function closeDialog(): void {
  const { dialog } = state();
  if (dialog?.kind === "confirm-close") dialog.resolve("cancel");
  else if (dialog) nextDialog();
}

// ---- Activation --------------------------------------------------------------

let activationToken = 0;
let activation: Promise<void> = Promise.resolve();

/** Switches tabs. `whenActivated` resolves once the editor shows the tab. */
function activate(id: string): Promise<void> {
  let done: () => void = () => {};
  activation = new Promise<void>((resolve) => {
    done = resolve;
  });
  const run = doActivate(id);
  run.then(done, done);
  return run;
}

/** Settles when the latest tab switch has put its document in the editor (or given up). */
const whenActivated = (): Promise<void> => activation;

async function doActivate(id: string): Promise<void> {
  const s = state();
  if (!getTab(id)) return;
  if (s.activeId !== id) loader.touchTab(s.activeId);
  useApp.setState({ activeId: id, view: "editor" });
  const token = ++activationToken;
  if (!engine.hasDoc(id)) {
    // The tab strip already shows this tab: typing must not reach the previous one
    // while it loads (BUGS.md C8).
    engine.park();
    await loader.materialiseOrFlag(id);
  }
  if (token !== activationToken || !engine.hasDoc(id)) return;
  if (leaving.has(id)) {
    engine.park(); // moving to another window: shown read-only until it goes
    return;
  }
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
  /** Lines for the error message, and the paths to drop from Recent. */
  const failed: string[] = [];
  const failedPaths: string[] = [];
  let target: string | null = null;
  let targetPath = "";
  const created: string[] = [];

  paths.forEach((path, index) => {
    const existing = findOpen(path);
    if (existing) {
      target = existing.id;
      targetPath = path;
      addRecent(path);
      return;
    }
    const stamp = stats[index];
    if (!stamp) {
      failed.push(path);
      failedPaths.push(path);
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
      tailChars: null,
      externalChange: null,
      hibernated: true,
    };
    addTab(tab);
    created.push(tab.id);
    target = tab.id;
    targetPath = path;
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
      if (created.includes(targetId)) {
        removeFromList(targetId);
        failedPaths.push(targetPath);
      }
      failed.push(`${fileNameOf(targetPath)}: ${errorText(error)}`);
    }
  }

  if (failed.length > 0) {
    useApp.setState((s) => ({ recent: s.recent.filter((r) => !failedPaths.some((f) => pathsEqual(f, r))) }));
    showMessage("Could not open file", failed.join("\n"));
  }
}

/** One untitled, empty tab and nothing else: a file may as well open here. */
function windowIsPristine(): boolean {
  const { tabs } = state();
  return tabs.length === 1 && isPristine(tabs[0]);
}

async function openPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  // An empty window takes the file instead of leaving itself behind (M10).
  if (state().settings.openFilesIn !== "window" || windowIsPristine()) return openHere(paths);
  const fresh = dedupePaths(paths).filter((p) => !findOpen(p));
  const open = paths.map(findOpen).filter((t): t is TabMeta => !!t);
  if (open.length > 0) {
    await activate(open[open.length - 1].id);
    await bringToFront();
  }
  if (fresh.length > 0) await ipc.newWindow(fresh).catch(reportError("Could not open a new window"));
}

async function bringToFront(): Promise<void> {
  const win = getCurrentWindow();
  await win.unminimize().catch(() => {});
  await win.show().catch(() => {});
  await win.setFocus().catch(() => {});
}

/**
 * M11: a name given on the command line that does not exist yet. Like Notepad,
 * ask whether to create it; an empty file is written on yes.
 */
async function createMissing(paths: string[]): Promise<string[]> {
  const stats = await Promise.all(paths.map((p) => ipc.stat(p).catch(() => undefined)));
  const kept: string[] = [];
  for (const [index, path] of paths.entries()) {
    if (stats[index] !== null) {
      kept.push(path);
      continue;
    }
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const create = await ask(`Cannot find the ${fileNameOf(path)} file.\n\nDo you want to create a new file?`, {
      title: "Notepadly",
      kind: "warning",
    });
    if (!create) continue;
    try {
      await ipc.save({ path, text: "", eol: "CRLF", encoding: "utf-8", tailOffset: null, expectedStamp: null });
      kept.push(path);
    } catch (error) {
      showMessage("Could not create file", `${fileNameOf(path)}: ${errorText(error)}`);
    }
  }
  return kept;
}

/** Files from a second launch, sent to this window because it had the focus. */
async function openFromLaunch(paths: string[]): Promise<void> {
  const wanted = await createMissing(paths);
  if (wanted.length === 0) return;
  if (state().settings.openFilesIn === "window" && !windowIsPristine()) return openPaths(wanted);
  await openHere(wanted);
  await bringToFront();
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

/** A native message box with custom buttons; resolves to the label pressed. */
async function askUser(
  title: string,
  body: string,
  buttons: { ok: string; cancel: string } | { yes: string; no: string; cancel: string },
): Promise<string> {
  const { message } = await import("@tauri-apps/plugin-dialog");
  return message(body, { title, kind: "warning", buttons });
}

async function writeAndReport(id: string, path: string, options: loader.WriteOptions = {}): Promise<boolean> {
  const result = await loader.writeTab(id, path, options);
  if (result.ok) {
    addRecent(path);
    return true;
  }
  if (result.message.includes("UNMAPPABLE")) return saveUnmappable(id, path, options);
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

/**
 * The text has characters the ANSI code page cannot hold (BUGS.md C6). Saving
 * would turn them into `?` for good, so the user chooses.
 */
async function saveUnmappable(id: string, path: string, options: loader.WriteOptions): Promise<boolean> {
  const toUtf8 = "Save as UTF-8";
  const lossy = "Save as ANSI";
  const answer = await askUser(
    "Some characters cannot be saved",
    `${fileNameOf(path)} is saved in ANSI, which cannot hold some of the characters in it. In ANSI they would become "?" for good.\n\nSave it as UTF-8 instead?`,
    { yes: toUtf8, no: lossy, cancel: "Cancel" },
  );
  if (answer === lossy) return writeAndReport(id, path, { ...options, allowLossy: true });
  if (answer !== toUtf8) return false;
  // The unloaded rest of the file is ANSI bytes: it must be read before the encoding changes.
  if (!options.loadedOnly) {
    try {
      await ensureFullyLoaded(id);
    } catch {
      return false;
    }
  }
  patchTab(id, { encoding: "utf-8" });
  loader.forceDirty(id);
  loader.scheduleSessionWrite();
  return writeAndReport(id, path, options);
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
  const path = chosenSavePath(chosen);
  const movesFile = !pathsEqual(path, tab.path);
  // Another tab showing the file about to be replaced would be left stale.
  const other = movesFile ? state().tabs.find((t) => t.id !== id && pathsEqual(t.path, path)) : undefined;
  if (other?.dirty) {
    showMessage(
      "Could not save file",
      `${fileNameOf(path)} is open in another tab with unsaved changes. Save or close that tab first.`,
    );
    return false;
  }
  let loadedOnly = false;
  if (movesFile) {
    try {
      await loader.ensureFullyLoaded(id);
    } catch (error) {
      if (!(error instanceof loader.LoadBlockedError)) {
        showMessage("Could not save file", errorText(error));
        return false;
      }
      // The rest of the old file is gone, but the loaded text is still worth keeping.
      const keep = "Save loaded part";
      const answer = await askUser(
        "File changed on disk",
        `This file was changed by another program while only part of it was loaded, so the rest of it can no longer be read.\n\nSave the loaded part, with your changes, as ${fileNameOf(path)}?`,
        { ok: keep, cancel: "Cancel" },
      );
      if (answer !== keep) return false;
      loadedOnly = true;
    }
  }
  if (!(await writeAndReport(id, path, { loadedOnly }))) return false;
  if (movesFile) {
    const replaced = other && getTab(other.id);
    if (replaced && !replaced.dirty) {
      if (state().activeId === replaced.id) await activate(id);
      removeFromList(replaced.id);
    } else if (replaced) {
      patchTab(replaced.id, { externalChange: "modified" });
    }
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

/** `moved`: the tab went to another window, which now owns its draft. */
function removeFromList(id: string, moved = false): void {
  useApp.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }));
  engine.dropDoc(id); // also forgets the undo history of a hibernated tab
  if (moved) loader.releaseTab(id);
  else loader.disposeTab(id);
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

/**
 * Decides whether this window may go. True means every tab has been answered for.
 * With "continue previous session", the last window (or every window on Exit)
 * keeps its tabs as drafts without asking; a window closed while others stay
 * open asks about its unsaved tabs, like Notepad, and its session is removed.
 */
async function prepareWindowClose(exiting = false): Promise<boolean> {
  if (closeInProgress) return false;
  closeInProgress = true;
  try {
    flushPersistedPrefs();
    flushTitles();
    if (keepsSession() && (exiting || (await ipc.isLastWindow().catch(() => true)))) {
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
    await loader.discardCurrentSession().catch(() => {});
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
  clearDialogs();
  useApp.setState({ view: "editor", find: { open: false, replace: false } });
  if (keepsSession()) return; // the session is what comes back
  const old = state().tabs.map((t) => t.id);
  await newTab();
  old.forEach((id) => removeFromList(id));
}

async function closeWindow(): Promise<void> {
  await getCurrentWindow().close();
}

/** Stores (or asks about) this window's tabs and closes it for good, even in background mode. */
async function exitThisWindow(): Promise<void> {
  if (!(await prepareWindowClose(true))) return;
  await getCurrentWindow().destroy();
}

/**
 * File > Exit (M17): every window stores or resolves its own tabs and closes; the
 * app ends when the last one is gone. With "continue previous session" all of
 * them come back on the next start.
 */
async function exit(): Promise<void> {
  try {
    await getCurrentWebviewWindow().emit(EXIT_EVENT, { from: windowLabel });
  } catch (error) {
    console.error("Notepadly: could not tell the other windows to close", error);
  }
  await exitThisWindow();
}

// ---- Moving tabs between windows (F2) ------------------------------------------

export interface TabTransfer {
  /** Label of the window the tab comes from; it waits for TAB_RECEIVED_EVENT. */
  from: string;
  tab: TabMeta;
  handoff: loader.TabHandoff;
}

const receipts = new Map<string, () => void>();
/** Tabs whose text has been sent to another window; they stay read-only meanwhile. */
const leaving = new Set<string>();

function waitForReceipt(id: string): { done: Promise<boolean>; cancel: () => void } {
  let cancel = () => {};
  const done = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), MOVE_TIMEOUT_MS);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      receipts.delete(id);
      resolve(ok);
    };
    receipts.set(id, () => finish(true));
    cancel = () => finish(false);
  });
  return { done, cancel };
}

/**
 * Moves a tab dragged out of the tab strip: onto the window under the mouse, or
 * into a new window there. The tab is removed here only once the other window
 * has it, so a failed move leaves it where it was. Nothing is saved or reloaded.
 * `toNewWindow` (the tab menu's "Move to new window", for keyboard and touch):
 * always a new window, placed as usual rather than at the mouse.
 */
async function moveTabOut(id: string, toNewWindow = false): Promise<void> {
  if (!getTab(id)) return;
  const target = toNewWindow ? null : await ipc.tabDropTarget().catch(() => null);
  await loader.settleTabIo(id);
  const tab = getTab(id);
  if (!tab) return;
  const { tabs, activeId } = state();
  // The text is read now; switching away first keeps typing out of a tab in transit.
  if (activeId === id && tabs.length > 1) {
    const next = neighbourAfterClose(tabs.map((t) => t.id), id);
    if (next) await activate(next);
  }
  // A pending name from the first line goes with the tab (STATE-4, like T2).
  const pendingTitle = titleTimers.get(id);
  if (pendingTitle !== undefined) {
    clearTimeout(pendingTitle);
    updateTitle(id);
  }
  const current = getTab(id);
  if (!current) return;
  const transfer: TabTransfer = { from: windowLabel, tab: current, handoff: loader.handOff(id) };
  // Its text is on the way: an edit made here now would be lost (STATE-3).
  leaving.add(id);
  if (state().activeId === id) engine.park();
  const stay = (message: string) => {
    leaving.delete(id);
    if (state().activeId === id) void activate(id);
    showMessage("Could not move the tab", message);
  };
  const receipt = waitForReceipt(id);
  try {
    if (target) {
      await getCurrentWebviewWindow().emitTo(target.label, TAB_INCOMING_EVENT, { transfer, x: target.x, y: target.y });
    } else {
      await ipc.newWindow([], { transfer: JSON.stringify(transfer), atCursor: !toNewWindow });
    }
  } catch (error) {
    receipt.cancel();
    stay(errorText(error));
    return;
  }
  if (!(await receipt.done)) {
    stay("The other window did not take the tab, so it stays here.");
    return;
  }
  leaving.delete(id);
  if (state().tabs.length > 1) {
    removeFromList(id, true);
    return;
  }
  // The last tab left: the window goes with it instead of staying empty.
  await newTab();
  removeFromList(id, true);
  await loader.discardCurrentSession().catch(() => {});
  await getCurrentWindow().destroy();
}

/** Takes a tab moved here from another window, at `index` (null: at the end). */
async function receiveTab(transfer: TabTransfer, index: number | null): Promise<void> {
  const { from, handoff } = transfer;
  const tab: TabMeta = { ...transfer.tab, hibernated: handoff.text === null && transfer.tab.path !== null };
  const answer = () =>
    getCurrentWebviewWindow()
      .emitTo(from, TAB_RECEIVED_EVENT, { id: tab.id })
      .catch((error: unknown) => console.error("Notepadly: could not confirm a moved tab", error));
  if (getTab(tab.id)) {
    await answer();
    return;
  }
  const pristine = windowIsPristine() ? state().tabs[0] : null;
  useApp.setState((s) => {
    const list = s.tabs.slice();
    list.splice(Math.max(0, Math.min(index ?? list.length, list.length)), 0, tab);
    return { tabs: list };
  });
  loader.takeOver(tab, handoff);
  await answer();
  await activate(tab.id);
  if (pristine && pristine.id !== tab.id) removeFromList(pristine.id);
}

function parseTransfer(raw: unknown): TabTransfer | null {
  const t = (typeof raw === "string" ? JSON.parse(raw) : raw) as TabTransfer | null;
  return t && typeof t.from === "string" && t.tab && typeof t.tab.id === "string" && t.handoff ? t : null;
}

// ---- Settings ----------------------------------------------------------------

function syncWindowTheme(): void {
  const { theme } = state().settings;
  getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {});
}

/** Each tab's view before Formatting was turned off, so turning it on brings it back (M19). */
const modeBeforeFormattingOff = new Map<string, FormatMode>();

function applyFormattingSetting(formatting: boolean): void {
  for (const tab of state().tabs) {
    if (tab.path !== null && !isMarkdownPath(tab.path)) continue;
    if (!formatting && tab.mode !== "plain") {
      modeBeforeFormattingOff.set(tab.id, tab.mode);
      applyMode(tab.id, "plain");
    } else if (formatting && tab.mode === "plain") {
      applyMode(tab.id, modeBeforeFormattingOff.get(tab.id) ?? "formatted");
    }
  }
  if (formatting) modeBeforeFormattingOff.clear();
}

/**
 * The status bar's mode button (M19): Formatted and Markdown syntax for Markdown;
 * any other file (a .txt) can also be shown formatted and goes back to Plain text.
 */
function nextMode(): void {
  const tab = getActiveTab();
  if (!tab) return;
  const markdownOnly = tab.path === null || isMarkdownPath(tab.path);
  const next: FormatMode =
    tab.mode === "plain" ? "formatted" : tab.mode === "formatted" ? "syntax" : markdownOnly ? "formatted" : "plain";
  applyMode(tab.id, next);
}

function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  useApp.setState((s) => ({ settings: { ...s.settings, [key]: value } }));
  applySetting(key, value, true);
}

/** Makes a changed setting take effect. `own` is false for a change made in another window. */
function applySetting<K extends keyof Settings>(key: K, value: Settings[K], own: boolean): void {
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
      if (own && !value) useApp.setState({ recent: [] });
      break;
    case "startup":
      loader.setPersistence(value === "continue");
      break;
    case "autoUpdate":
      if (own) ipc.updateConfigure(value as boolean).catch(() => {});
      break;
  }
}

/** H12: settings changed in another window take effect here too. */
onSharedSettings((before, after) => {
  for (const key of Object.keys(after) as (keyof Settings)[]) {
    if (before[key] !== after[key]) applySetting(key, after[key], false);
  }
});

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
  if ("eol" in patch) loader.markEolChosen(id);
  loader.forceDirty(id);
  loader.scheduleSessionWrite();
}

/** Reads the active file again in another encoding, for a wrong guess (BUGS.md M15). */
async function reopenWithEncoding(encoding: Encoding): Promise<void> {
  const id = state().activeId;
  const tab = getTab(id);
  if (!tab?.path) return;
  if (tab.dirty) {
    const reopen = "Reopen";
    const answer = await askUser(
      "Reopen with encoding",
      `Reading ${tab.title} again throws away your unsaved changes. Reopen it anyway?`,
      { ok: reopen, cancel: "Cancel" },
    );
    if (answer !== reopen) return;
  }
  await loader.reopenWithEncoding(id, encoding).catch(reportError("Could not reopen file"));
}

// ---- Startup -----------------------------------------------------------------

/**
 * Registers every listener before Rust may send anything (M9): Rust counts the
 * window as ready once it took its pending paths, so the listeners come first.
 * What arrives before init finished waits for `ready`.
 */
async function wireWindowEvents(ready: Promise<void>): Promise<void> {
  const win = getCurrentWindow();
  const webviewWindow = getCurrentWebviewWindow();
  const warn = (what: string) => (error: unknown) => console.error(`Notepadly: ${what}`, error);
  const later = (run: () => Promise<void>) => void ready.then(run).catch(warn("window event failed"));

  // Rust sends these with emit_to(webview_window(label)), which only reaches
  // listeners registered with that exact target kind.
  const listeners = [
    webviewWindow
      .listen<string[]>(OPEN_PATHS_EVENT, (event) => later(() => openFromLaunch(event.payload)))
      .catch(warn("open-paths listener failed")),
    webviewWindow
      .listen<string[]>(OPEN_PATHS_HERE_EVENT, (event) =>
        later(async () => openHere(await createMissing(event.payload))),
      )
      .catch(warn("open-paths-here listener failed")),
    webviewWindow
      .listen<{ from: string }>(EXIT_EVENT, (event) => {
        if (event.payload?.from !== windowLabel) later(exitThisWindow);
      })
      .catch(warn("exit listener failed")),
    webviewWindow
      .listen<{ transfer: TabTransfer; x: number; y: number }>(TAB_INCOMING_EVENT, (event) =>
        later(async () => {
          const transfer = parseTransfer(event.payload?.transfer);
          if (!transfer) return;
          const index = typeof document === "undefined" ? null : dropIndexAt(event.payload.x, event.payload.y);
          await receiveTab(transfer, index);
          await bringToFront();
        }),
      )
      .catch(warn("tab listener failed")),
    webviewWindow
      .listen<{ id: string }>(TAB_RECEIVED_EVENT, (event) => receipts.get(event.payload?.id)?.())
      .catch(warn("tab receipt listener failed")),
  ];

  getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const paths = event.payload.paths;
        later(() => openPaths(paths));
      }
    })
    .catch(warn("drag and drop listener failed"));

  const closeListener = win
    .onCloseRequested(async (event) => {
      // A close before startup finished waits for it, instead of skipping the drafts.
      await ready.catch(() => {});
      if (!(await prepareWindowClose())) {
        event.preventDefault();
        return;
      }
      // Like Notepad: the last window hides and waits instead of quitting.
      if (!state().settings.background || !(await ipc.isLastWindow().catch(() => false))) return;
      event.preventDefault();
      await resetForBackground();
      await ipc
        .enterBackground()
        // Hidden now: the open animation plays when the window comes back.
        .then(markAsleep)
        .catch(async (error) => {
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

  await Promise.all([...listeners, closeListener]);
}

async function restoreSession(session: SessionFile | null): Promise<boolean> {
  if (!session || session.tabs.length === 0) return false;
  session.tabs.forEach(loader.registerRestored);
  useApp.setState({ tabs: session.tabs.map(tabFromSession), activeId: session.activeId });
  await loader.materialiseOrFlag(session.activeId);
  return true;
}

interface StoredSession {
  /** null for the old single session.json. */
  key: string | null;
  session: SessionFile;
}

/** Every stored window session with tabs in it; the old session.json first. */
async function readStoredSessions(): Promise<StoredSession[]> {
  const [legacy, keyed] = await Promise.all([
    ipc.sessionRead().catch(() => null),
    ipc.windowSessionsRead().catch(() => []),
  ]);
  const found: StoredSession[] = [];
  const old = parseSession(legacy);
  if (old && old.tabs.length > 0) found.push({ key: null, session: old });
  for (const { key, json } of keyed) {
    const session = parseSession(json);
    if (session && session.tabs.length > 0) found.push({ key, session });
  }
  return found;
}

/** `startup: "new"` promises to discard the previous session's unsaved text, in every window. */
async function discardStoredSessions(stored: StoredSession[]): Promise<void> {
  await loader.discardSession(stored.find((s) => s.key === null)?.session ?? null);
  for (const { key, session } of stored) {
    if (key === null) continue;
    await Promise.all(session.tabs.filter((t) => t.hasDraft).map((t) => ipc.draftDelete(t.id).catch(() => {})));
    await ipc.windowSessionDelete(key).catch(() => {});
  }
}

/**
 * Picks up the session this window should show (C5, M18). The first window takes
 * one stored session and opens a window for each other one. A window opened for
 * a stored session takes that one. Returns the keys merged into this window.
 */
async function adoptSession(boot: WindowBoot): Promise<{ restored: boolean; merged: string[] }> {
  const none = { restored: false, merged: [] as string[] };
  if (!isFirstWindow()) {
    loader.setSessionKey(boot.restore ?? `w${newTabId()}`);
    if (!boot.restore || !keepsSession()) return none;
    const mine = (await readStoredSessions()).find((s) => s.key === boot.restore);
    return { restored: await restoreSession(mine?.session ?? null), merged: [] };
  }
  const stored = await readStoredSessions();
  if (!keepsSession()) {
    discardStoredSessions(stored).catch(() => {});
    return none;
  }
  if (stored.length === 0) return none;
  const [mine, ...others] = stored;
  loader.setSessionKey(mine.key);
  // The hidden restart after an update shows no windows: keep every tab in this one.
  if (others.length > 0 && (await ipc.launchedHidden().catch(() => false))) {
    const seen = new Set(mine.session.tabs.map((t) => t.id));
    const tabs = [...mine.session.tabs];
    for (const other of others) for (const t of other.session.tabs) if (!seen.has(t.id) && seen.add(t.id)) tabs.push(t);
    return { restored: await restoreSession({ ...mine.session, tabs }), merged: others.map((o) => o.key as string) };
  }
  for (const other of others) {
    await ipc.newWindow([], { restore: other.key as string }).catch(reportError("Could not open a window"));
  }
  return { restored: await restoreSession(mine.session), merged: [] };
}

async function runInit(): Promise<void> {
  windowLabel = getCurrentWindow().label;
  installShortcuts();
  syncWindowTheme();
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  await Promise.all([waitForEditorParent(), wireWindowEvents(ready)]);

  const [pending, boot] = await Promise.all([
    ipc.takePendingPaths().catch(() => [] as string[]),
    ipc.takeWindowBoot().catch((): WindowBoot => ({ restore: null, transfer: null })),
  ]);
  const { restored, merged } = await adoptSession(boot);

  const { activeId } = state();
  if (!restored) engine.createDoc(activeId, "", getTab(activeId)?.mode ?? "plain");
  if (engine.hasDoc(activeId)) {
    engine.activate(activeId);
    engine.focus();
  }
  // The first window clears out drafts that no stored session owns. Drafts of
  // the other stored sessions are kept: their windows are restoring them now.
  if (isFirstWindow() && keepsSession()) {
    readStoredSessions()
      .then((stored) => loader.pruneDrafts(stored.flatMap((s) => s.session.tabs.filter((t) => t.hasDraft).map((t) => t.id))))
      .catch(() => {});
  }
  loader.setPersistence(keepsSession());
  initFinished = true;

  if (merged.length > 0) {
    // Stored once in this window's session, the merged ones can go.
    await loader.flushPersistence().catch(() => {});
    await Promise.all(merged.map((key) => ipc.windowSessionDelete(key).catch(() => {})));
  }
  const transfer = boot.transfer ? (() => {
    try {
      return parseTransfer(boot.transfer);
    } catch {
      return null;
    }
  })() : null;
  if (transfer) await receiveTab(transfer, null);
  await openHere(await createMissing(pending));
  markReady();
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
  // A tab that is already gone (a stale context menu, BUGS.md UI-2) closes nothing.
  closeOthers: (id: string) =>
    getTab(id) ? closeMany(state().tabs.filter((t) => t.id !== id).map((t) => t.id)) : Promise.resolve(),
  closeToRight: (id: string) => {
    const ids = state().tabs.map((t) => t.id);
    const index = ids.indexOf(id);
    return index < 0 ? Promise.resolve() : closeMany(ids.slice(index + 1));
  },
  closeWindow,
  exit,
  moveTabOut,

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
  nextMode,
  toggleSyntax: () => {
    const tab = getActiveTab();
    if (tab && tab.mode !== "plain") applyMode(tab.id, tab.mode === "formatted" ? "syntax" : "formatted");
  },

  setSetting,
  zoomBy: (delta: number) => setSetting("zoom", clampZoom(state().settings.zoom + delta)),
  zoomReset: () => setSetting("zoom", 100),

  setEol: (eol: Eol) => changeFileFormat({ eol }),
  setEncoding: (encoding: Encoding) => changeFileFormat({ encoding }),
  reopenWithEncoding,

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
  whenActivated,

  insertDateTime: () => engine.insertText(formatDateTime(new Date())),
  /** Edit > Cut / Copy / Paste. A clipboard failure is reported, and Cut then keeps the text. */
  clipboard: (op: "cut" | "copy" | "paste"): Promise<void> =>
    engine[op]().catch(reportError(op === "paste" ? "Could not paste" : "Could not copy to the clipboard")),
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
    pushDialog(dialog);
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
