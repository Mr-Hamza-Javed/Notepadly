// File I/O rules 2, 3, 6, 7, 8 and 9 of the spec: chunked loading, partial saves,
// external change polling, background scans, drafts, session and hibernation.
import { engine } from "../editor";
import type { ScrollSnapshot } from "../editor/api";
import { ipc, type Encoding, type Eol, type FileStamp } from "./ipc";
import {
  decideExternal,
  fileNameOf,
  loadedOffsetAfterPartialSave,
  pathsEqual,
  stampsEqual,
  type DismissedChange,
  type SessionFile,
  type SessionTab,
} from "../state/logic";
import { getTab, patchTab, setLoadProgress, showMessage, useApp } from "../state/store";
import type { TabMeta } from "../state/types";

export const FIRST_CHUNK = 256 * 1024;
export const SMALL_FILE = 2 * 1024 * 1024;
export const NEXT_CHUNK = 1024 * 1024;
const RELOAD_CHUNK = 4 * 1024 * 1024;
const MIN_READ = 64 * 1024;
const POLL_MS = 3000;
const DRAFT_DEBOUNCE_MS = 800;
const HIBERNATE_AFTER_MS = 60_000;
const HIBERNATE_SWEEP_MS = 15_000;
const HIBERNATE_MIN_BYTES = 1024 * 1024;

const noop = () => {};

interface DraftMeta {
  stamp: FileStamp | null;
  loadedOffset: number;
  fullyLoaded: boolean;
}

interface TabRuntime {
  /** Bumped to invalidate reads already on the wire (close, reload, hibernate). */
  gen: number;
  /** The single chunk read allowed per tab. */
  inFlight: Promise<void> | null;
  materialising: Promise<void> | null;
  fullLoad: Promise<void> | null;
  /** Saves and reloads run one at a time; chunk reads wait while busy > 0. */
  queue: Promise<void>;
  busy: number;
  cancelIdle: (() => void) | null;
  scanStarted: boolean;
  /** Counts document edits, to spot typing during a save or a silent reload. */
  editSeq: number;
  /** Bumped around saves and reloads so a late stat answer is ignored. */
  ioSeq: number;
  /** The editor's clean point does not match disk (restored draft, deleted file). */
  forceDirty: boolean;
  lastActive: number;
  snap: ScrollSnapshot | null;
  dismissed: DismissedChange;
  hasDraft: boolean;
  /** Which file state the stored draft belongs to: the session must match it. */
  draftMeta: DraftMeta | null;
}

const runtimes = new Map<string, TabRuntime>();

function rtOf(id: string): TabRuntime {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = {
      gen: 0,
      inFlight: null,
      materialising: null,
      fullLoad: null,
      queue: Promise.resolve(),
      busy: 0,
      cancelIdle: null,
      scanStarted: false,
      editSeq: 0,
      ioSeq: 0,
      forceDirty: false,
      lastActive: Date.now(),
      snap: null,
      dismissed: null,
      hasDraft: false,
      draftMeta: null,
    };
    runtimes.set(id, rt);
  }
  return rt;
}

const settle = (p: Promise<unknown> | null): Promise<void> => (p ? p.then(noop, noop) : Promise.resolve());

/** Runs saves and reloads for one tab strictly in order. */
function enqueue<T>(rt: TabRuntime, op: () => Promise<T>): Promise<T> {
  rt.busy++;
  const run = rt.queue.then(op).finally(() => {
    rt.busy--;
  });
  rt.queue = settle(run);
  return run;
}

/** The bytes after loadedOffset are only trustworthy while the file is unchanged. */
const tailUsable = (tab: TabMeta, rt: TabRuntime) => !tab.externalChange && rt.dismissed === null;

export class LoadBlockedError extends Error {
  constructor() {
    super("This file changed on disk while only part of it was loaded. Reload it to continue.");
  }
}

function onIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(callback, { timeout: 500 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(callback, 16);
  return () => clearTimeout(handle);
}

function startScan(id: string): void {
  const tab = getTab(id);
  if (!tab || !tab.path || tab.fullyLoaded) return;
  const rt = rtOf(id);
  if (rt.scanStarted) return;
  rt.scanStarted = true;
  const { gen, ioSeq } = rt;
  ipc
    .scan(tab.path, tab.encoding)
    .then((result) => {
      if (rt.gen !== gen || rt.ioSeq !== ioSeq) return;
      const current = getTab(id);
      if (current && !current.fullyLoaded) patchTab(id, { totalChars: result.chars });
    })
    .catch(noop);
}

function scheduleIdleLoad(id: string): void {
  const tab = getTab(id);
  if (!tab || !tab.path || tab.fullyLoaded || !tab.stamp || tab.stamp.size > SMALL_FILE) return;
  const rt = rtOf(id);
  if (rt.cancelIdle || !tailUsable(tab, rt)) return;
  rt.cancelIdle = onIdle(() => {
    rt.cancelIdle = null;
    loadStep(id, FIRST_CHUNK).then(() => scheduleIdleLoad(id), noop);
  });
}

function cancelIdleLoad(rt: TabRuntime): void {
  rt.cancelIdle?.();
  rt.cancelIdle = null;
}

/** The file moved under a partly read tab: its byte offsets mean nothing now. */
function onChangedMidLoad(id: string): void {
  const tab = getTab(id);
  if (!tab) return;
  if (tab.dirty) patchTab(id, { externalChange: "modified" });
  else silentReload(id).catch(noop);
}

/** Reads one chunk past the loaded end. At most one runs per tab. */
function loadStep(id: string, maxBytes: number): Promise<void> {
  const tab = getTab(id);
  if (!tab || !tab.path || tab.fullyLoaded || !engine.hasDoc(id)) return Promise.resolve();
  const rt = rtOf(id);
  if (rt.inFlight) return rt.inFlight;
  if (rt.busy > 0) return rt.queue;
  if (!tailUsable(tab, rt)) return Promise.resolve();
  const { gen } = rt;
  const offset = tab.loadedOffset;
  const read = (async () => {
    const chunk = await ipc.readChunk(tab.path as string, offset, maxBytes, tab.encoding);
    const current = getTab(id);
    if (rt.gen !== gen || !current) return;
    // A chunk from a different file state must not be spliced in, and adopting
    // its stamp would let a later partial save pass with a meaningless offset.
    if (!stampsEqual(current.stamp, chunk.stamp)) {
      onChangedMidLoad(id);
      return;
    }
    if (chunk.nextOffset <= offset && !chunk.eof) throw new Error("The file could not be read any further.");
    if (chunk.text) engine.appendText(id, chunk.text);
    patchTab(id, {
      loadedOffset: chunk.nextOffset,
      fullyLoaded: chunk.eof,
      stamp: chunk.stamp,
      totalChars: chunk.eof ? null : current.totalChars,
    });
    if (current.dirty) markDraftChanged(id);
    if (!chunk.eof) startScan(id);
  })().finally(() => {
    if (rt.inFlight === read) rt.inFlight = null;
  });
  rt.inFlight = read;
  return read;
}

export function onNearEnd(id: string): void {
  const tab = getTab(id);
  if (!tab || tab.fullyLoaded) return;
  loadStep(id, (tab.stamp?.size ?? 0) <= SMALL_FILE ? FIRST_CHUNK : NEXT_CHUNK).catch(noop);
}

/** Loads everything that remains, a chunk at a time, yielding to input between chunks. */
export function ensureFullyLoaded(id: string): Promise<void> {
  const initial = getTab(id);
  if (!initial || (initial.fullyLoaded && engine.hasDoc(id))) return Promise.resolve();
  const rt = rtOf(id);
  if (rt.fullLoad) return rt.fullLoad;
  const run = (async () => {
    let stalled = 0;
    try {
      for (;;) {
        if (!engine.hasDoc(id)) await materialise(id);
        const tab = getTab(id);
        if (!tab || tab.fullyLoaded) return;
        if (!tailUsable(tab, rt)) throw new LoadBlockedError();
        setLoadProgress({ tabId: id, loaded: tab.loadedOffset, total: tab.stamp?.size ?? tab.loadedOffset });
        await loadStep(id, NEXT_CHUNK);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const after = getTab(id);
        if (after && after.loadedOffset === tab.loadedOffset && !after.fullyLoaded && rt.busy === 0) {
          if (++stalled > 3) {
            if (!tailUsable(after, rt)) throw new LoadBlockedError();
            throw new Error("The file could not be read any further.");
          }
        } else stalled = 0;
      }
    } finally {
      setLoadProgress(null);
    }
  })().finally(() => {
    rt.fullLoad = null;
  });
  rt.fullLoad = run;
  return run;
}

interface DiskRead {
  text: string;
  stamp: FileStamp;
  nextOffset: number;
  eof: boolean;
  encoding: Encoding;
  eol: Eol;
}

/** Reads from byte 0 to about `target`. Restarts if the file changes part way. */
async function readUpTo(path: string, target: number, isCurrent: () => boolean): Promise<DiskRead | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts: string[] = [];
    let offset = 0;
    let first: { stamp: FileStamp; encoding: Encoding; eol: Eol } | null = null;
    for (;;) {
      const wanted = Math.min(RELOAD_CHUNK, Math.max(MIN_READ, target - offset));
      const size = offset === 0 ? Math.max(FIRST_CHUNK, wanted) : wanted;
      const chunk = await ipc.readChunk(path, offset, size, first?.encoding ?? null);
      if (!isCurrent()) return null;
      if (first && !stampsEqual(first.stamp, chunk.stamp)) {
        first = null;
        break;
      }
      first ??= { stamp: chunk.stamp, encoding: chunk.encoding, eol: chunk.eol };
      if (chunk.nextOffset <= offset && !chunk.eof) throw new Error("The file could not be read.");
      parts.push(chunk.text);
      offset = chunk.nextOffset;
      if (chunk.eof || target <= FIRST_CHUNK || offset >= target) {
        return { ...first, text: parts.join(""), nextOffset: offset, eof: chunk.eof };
      }
    }
  }
  throw new Error("The file kept changing while it was being read.");
}

function restoreView(id: string, snap: ScrollSnapshot | null): void {
  if (!snap) return;
  const length = engine.length(id);
  engine.restore(id, {
    anchor: Math.min(snap.anchor, length),
    head: Math.min(snap.head, length),
    scrollTop: snap.scrollTop,
  });
}

/** Makes the editor match disk. Not queued: callers decide the ordering. */
async function applyFromDisk(
  id: string,
  target: number,
  snap: ScrollSnapshot | null,
  silent: boolean,
): Promise<void> {
  const rt = rtOf(id);
  const start = getTab(id);
  if (!start?.path) return;
  const gen = ++rt.gen;
  rt.ioSeq++;
  cancelIdleLoad(rt);
  await settle(rt.inFlight);
  const editsAtStart = rt.editSeq;
  const read = await readUpTo(start.path, target, () => rt.gen === gen && !!getTab(id));
  const tab = getTab(id);
  if (!read || !tab || rt.gen !== gen) return;
  if (silent && (rt.editSeq !== editsAtStart || tab.dirty)) {
    // The user started typing while the read was out: their text wins.
    patchTab(id, { externalChange: "modified" });
    return;
  }
  if (engine.hasDoc(id)) engine.resetDoc(id, read.text);
  else engine.createDoc(id, read.text, tab.mode);
  restoreView(id, snap);
  patchTab(id, {
    stamp: read.stamp,
    eol: read.eol,
    encoding: read.encoding,
    loadedOffset: read.nextOffset,
    fullyLoaded: read.eof,
    totalChars: null,
    dirty: false,
    externalChange: null,
    hibernated: false,
  });
  rt.forceDirty = false;
  rt.dismissed = null;
  rt.scanStarted = false;
  rt.ioSeq++;
  rt.snap = null;
  markDraftChanged(id);
  if (!read.eof) {
    startScan(id);
    scheduleIdleLoad(id);
  }
}

function reloadTarget(tab: TabMeta): number {
  return Math.max(FIRST_CHUNK, tab.loadedOffset);
}

function silentReload(id: string): Promise<void> {
  const rt = rtOf(id);
  return enqueue(rt, async () => {
    const tab = getTab(id);
    if (tab) await applyFromDisk(id, reloadTarget(tab), engine.hasDoc(id) ? engine.snapshot(id) : rt.snap, true);
  });
}

/** Explicit reload from the bar or the STALE message: replaces the tab's text. */
export function reloadFromDisk(id: string): Promise<void> {
  const rt = rtOf(id);
  return enqueue(rt, async () => {
    await settle(rt.materialising);
    const tab = getTab(id);
    if (tab) await applyFromDisk(id, reloadTarget(tab), engine.hasDoc(id) ? engine.snapshot(id) : rt.snap, false);
  });
}

/** Builds the editor state of a tab that only exists as metadata. */
export function materialise(id: string): Promise<void> {
  if (engine.hasDoc(id)) return Promise.resolve();
  const rt = rtOf(id);
  if (rt.materialising) return rt.materialising;
  const run = (async () => {
    const tab = getTab(id);
    if (!tab) return;
    if (tab.dirty && rt.hasDraft) {
      const draft = await ipc.draftRead(id).catch(() => null);
      if (!getTab(id) || engine.hasDoc(id)) return;
      if (draft !== null) {
        engine.createDoc(id, draft, tab.mode);
        restoreView(id, rt.snap);
        rt.snap = null;
        rt.forceDirty = true;
        patchTab(id, { hibernated: false });
        startScan(id);
        scheduleIdleLoad(id);
        return;
      }
      patchTab(id, { dirty: false });
    }
    if (!tab.path) {
      engine.createDoc(id, "", tab.mode);
      patchTab(id, { hibernated: false, dirty: false, fullyLoaded: true, loadedOffset: 0 });
      return;
    }
    const snap = rt.snap;
    const wantsPosition = !!snap && (snap.anchor > 0 || snap.head > 0 || snap.scrollTop > 0);
    await applyFromDisk(id, wantsPosition ? reloadTarget(tab) : FIRST_CHUNK, snap, false);
  })().finally(() => {
    rt.materialising = null;
  });
  rt.materialising = run;
  return run;
}

/** Like materialise, but always leaves an editor state, reporting what went wrong. */
export async function materialiseOrFlag(id: string): Promise<void> {
  try {
    await materialise(id);
  } catch (error) {
    const tab = getTab(id);
    if (!tab || engine.hasDoc(id)) return;
    const disk = tab.path ? await ipc.stat(tab.path).catch(() => undefined) : undefined;
    engine.createDoc(id, "", tab.mode);
    if (disk === null) {
      rtOf(id).forceDirty = true;
      patchTab(id, { hibernated: false, dirty: true, externalChange: "deleted", fullyLoaded: true, stamp: null });
    } else {
      patchTab(id, { hibernated: false, externalChange: "modified", loadedOffset: 0, fullyLoaded: false });
      showMessage("Could not open file", `${tab.title} could not be read.\n${String(error)}`);
    }
  }
}

// ---- Saving ----------------------------------------------------------------

export type WriteResult = { ok: true } | { ok: false; stale: boolean; message: string };

/** Serialised with loads and reloads, so byte offsets can never be read mid-rewrite. */
export function writeTab(id: string, targetPath: string): Promise<WriteResult> {
  const rt = rtOf(id);
  return enqueue(rt, () => doWrite(id, rt, targetPath));
}

/** Waits for any queued save or reload of this tab. */
export const settleTabIo = (id: string): Promise<void> => rtOf(id).queue;

async function doWrite(id: string, rt: TabRuntime, targetPath: string): Promise<WriteResult> {
  await settle(rt.inFlight);
  try {
    await materialise(id);
  } catch (error) {
    return { ok: false, stale: false, message: String(error) };
  }
  const tab = getTab(id);
  if (!tab) return { ok: false, stale: false, message: "The tab was closed." };
  const samePath = pathsEqual(tab.path, targetPath);
  const partial = !tab.fullyLoaded;
  if (partial && (!samePath || !tab.stamp)) {
    return { ok: false, stale: partial && samePath, message: "Only part of this file is loaded." };
  }
  const tailOffset = partial ? tab.loadedOffset : null;
  const oldSize = tab.stamp?.size ?? 0;
  const editsAtStart = rt.editSeq;
  const text = engine.getText(id);
  rt.ioSeq++;
  let stamp: FileStamp;
  try {
    stamp = await ipc.save({
      path: targetPath,
      text,
      eol: tab.eol,
      encoding: tab.encoding,
      tailOffset,
      // Rust answers STALE for a missing file, so recreating a deleted file must
      // send null. A partial tab keeps its stamp: its tail is gone with the file.
      expectedStamp: samePath && !(tab.externalChange === "deleted" && !partial) ? tab.stamp : null,
    });
  } catch (error) {
    rt.ioSeq++;
    const message = String(error);
    return { ok: false, stale: message.includes("STALE"), message };
  }
  rt.ioSeq++;
  if (!getTab(id)) return { ok: true };

  const unchanged = rt.editSeq === editsAtStart;
  if (unchanged) {
    engine.markSaved(id);
    rt.forceDirty = false;
  }
  rt.dismissed = null;
  const shared = {
    path: targetPath,
    title: fileNameOf(targetPath),
    stamp,
    dirty: !unchanged,
    externalChange: null,
  };
  if (tailOffset === null) {
    patchTab(id, { ...shared, loadedOffset: stamp.size, fullyLoaded: true, totalChars: null });
  } else {
    const next = loadedOffsetAfterPartialSave(stamp.size, oldSize, tailOffset);
    if (next === null) {
      // Cannot happen if Rust wrote text + tail. Re-reading stays correct, but costs the undo stack.
      patchTab(id, shared);
      await applyFromDisk(id, tailOffset, engine.snapshot(id), false);
    } else {
      patchTab(id, { ...shared, loadedOffset: next, totalChars: null });
      rt.scanStarted = false;
      startScan(id);
    }
  }
  markDraftChanged(id);
  return { ok: true };
}

// ---- Editor callbacks ------------------------------------------------------

export function noteEdit(id: string): void {
  rtOf(id).editSeq++;
  markDraftChanged(id);
}

export function noteDirty(id: string, dirty: boolean): void {
  if (!dirty && rtOf(id).forceDirty) return;
  const tab = getTab(id);
  if (!tab || tab.dirty === dirty) return;
  patchTab(id, { dirty });
  markDraftChanged(id);
}

/** For changes the editor cannot see, such as a new encoding or line ending. */
export function forceDirty(id: string): void {
  rtOf(id).forceDirty = true;
  patchTab(id, { dirty: true });
  markDraftChanged(id);
}

export function touchTab(id: string): void {
  rtOf(id).lastActive = Date.now();
}

/** Keeps the editor's text and stops offering a reload for this disk state. */
export async function keepMine(id: string): Promise<void> {
  const tab = getTab(id);
  if (!tab?.externalChange || !tab.path) return;
  const rt = rtOf(id);
  const kind = tab.externalChange;
  rt.ioSeq++;
  patchTab(id, { externalChange: null });
  if (kind === "deleted") {
    rt.dismissed = "deleted";
    if (tab.fullyLoaded) patchTab(id, { stamp: null });
    return;
  }
  const disk = await ipc.stat(tab.path).catch(() => null);
  rt.ioSeq++;
  if (!disk) return;
  // A fully loaded tab can overwrite freely. A partial one must not: its tail
  // offset refers to the old file, so its stamp stays old and a save gets STALE.
  if (tab.fullyLoaded) patchTab(id, { stamp: disk });
  else rt.dismissed = disk;
}

export function disposeTab(id: string): void {
  const rt = runtimes.get(id);
  if (!rt) return;
  rt.gen++;
  cancelIdleLoad(rt);
  changedDrafts.delete(id);
  if (rt.hasDraft && persistence) ipc.draftDelete(id).catch(noop);
  runtimes.delete(id);
}

export function registerRestored(session: SessionTab): void {
  const rt = rtOf(session.id);
  rt.snap = session.snap;
  rt.hasDraft = session.hasDraft;
  if (session.hasDraft) {
    rt.draftMeta = { stamp: session.stamp, loadedOffset: session.loadedOffset, fullyLoaded: session.fullyLoaded };
  }
}

/** Called once a freshly created document exists, for its background work. */
export function afterFirstLoad(id: string): void {
  startScan(id);
  scheduleIdleLoad(id);
}

// ---- External change polling -----------------------------------------------

let polling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function checkTab(tab: TabMeta): Promise<void> {
  const rt = rtOf(tab.id);
  if (!tab.path || rt.busy > 0) return;
  const seq = rt.ioSeq;
  const disk = await ipc.stat(tab.path).catch(() => undefined);
  if (disk === undefined || rt.ioSeq !== seq || rt.busy > 0) return;
  const current = getTab(tab.id);
  if (!current || current.path !== tab.path) return;
  const hasDoc = engine.hasDoc(tab.id);
  switch (decideExternal(current, disk, rt.dismissed, hasDoc)) {
    case "flag-modified":
      rt.dismissed = null;
      patchTab(tab.id, { externalChange: "modified" });
      break;
    case "flag-deleted":
      rt.forceDirty = true;
      patchTab(tab.id, { externalChange: "deleted", dirty: true });
      markDraftChanged(tab.id);
      break;
    case "clear-flag":
      rt.dismissed = null;
      patchTab(tab.id, { externalChange: null });
      break;
    case "reload":
      silentReload(tab.id).catch(noop);
      break;
    case "adopt-stamp":
      patchTab(tab.id, { stamp: disk });
      break;
    case "none":
      break;
  }
}

export async function pollExternalChanges(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    await Promise.all(useApp.getState().tabs.map(checkTab));
  } finally {
    polling = false;
  }
}

/** Rule 6: stat on focus and every 3 s while focused, never in the background. */
export function setWindowFocused(focused: boolean): void {
  if (focused === (pollTimer !== null)) return;
  if (focused) {
    pollExternalChanges().catch(noop);
    pollTimer = setInterval(() => pollExternalChanges().catch(noop), POLL_MS);
  } else {
    clearInterval(pollTimer as ReturnType<typeof setInterval>);
    pollTimer = null;
  }
}

// ---- Hibernation ------------------------------------------------------------

export function hibernateSweep(now = Date.now()): void {
  const { tabs, activeId } = useApp.getState();
  for (const tab of tabs) {
    if (tab.id === activeId || tab.dirty || !tab.path || tab.externalChange || tab.hibernated) continue;
    if (tab.loadedOffset <= HIBERNATE_MIN_BYTES || !engine.hasDoc(tab.id)) continue;
    const rt = rtOf(tab.id);
    if (rt.busy || rt.inFlight || rt.fullLoad || rt.materialising || rt.cancelIdle) continue;
    if (now - rt.lastActive < HIBERNATE_AFTER_MS) continue;
    rt.snap = engine.snapshot(tab.id);
    rt.gen++;
    engine.dropDoc(tab.id);
    patchTab(tab.id, { hibernated: true });
  }
}

export function startHibernation(): void {
  setInterval(hibernateSweep, HIBERNATE_SWEEP_MS);
}

// ---- Drafts and session ------------------------------------------------------

let persistence = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();
const changedDrafts = new Set<string>();

/** On only in the main window with `startup: "continue"`. */
export function setPersistence(enabled: boolean): void {
  if (enabled === persistence) return;
  persistence = enabled;
  if (enabled) {
    for (const tab of useApp.getState().tabs) if (tab.dirty) changedDrafts.add(tab.id);
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPersistence().catch((error) => console.error("Notepadly: session write failed", error));
  }, DRAFT_DEBOUNCE_MS);
}

export function markDraftChanged(id: string): void {
  if (!persistence) return;
  changedDrafts.add(id);
  scheduleFlush();
}

/** Joins a pending flush rather than restarting it, so drafts are never pushed back. */
export function scheduleSessionWrite(): void {
  if (persistence && flushTimer === null) scheduleFlush();
}

export function buildSession(): SessionFile {
  const { tabs, activeId } = useApp.getState();
  return {
    v: 1,
    activeId,
    tabs: tabs.map((tab) => {
      const rt = rtOf(tab.id);
      // A dirty tab restores from its draft, so it must describe that draft's
      // file position, which can lag behind chunks appended since.
      const position = tab.dirty && rt.draftMeta ? rt.draftMeta : tab;
      return {
        id: tab.id,
        path: tab.path,
        title: tab.title,
        dirty: tab.dirty,
        mode: tab.mode,
        eol: tab.eol,
        encoding: tab.encoding,
        stamp: position.stamp,
        loadedOffset: position.loadedOffset,
        fullyLoaded: position.fullyLoaded,
        hasDraft: rt.hasDraft,
        snap: engine.hasDoc(tab.id) ? engine.snapshot(tab.id) : rt.snap,
      };
    }),
  };
}

async function doFlush(): Promise<void> {
  const ids = [...changedDrafts];
  changedDrafts.clear();
  let failure: unknown = null;
  for (const id of ids) {
    const tab = getTab(id);
    if (!tab) continue;
    const rt = rtOf(id);
    try {
      if (tab.dirty) {
        if (!engine.hasDoc(id)) continue;
        const meta = { stamp: tab.stamp, loadedOffset: tab.loadedOffset, fullyLoaded: tab.fullyLoaded };
        await ipc.draftWrite(id, engine.getText(id));
        rt.hasDraft = true;
        rt.draftMeta = meta;
      } else if (rt.hasDraft) {
        await ipc.draftDelete(id);
        rt.hasDraft = false;
        rt.draftMeta = null;
      }
    } catch (error) {
      failure = error;
      changedDrafts.add(id);
    }
  }
  await ipc.sessionWrite(JSON.stringify(buildSession()));
  if (failure) throw failure;
}

/** Writes changed drafts, then the tab list. Rejects if any draft could not be stored. */
export function flushPersistence(): Promise<void> {
  if (!persistence) return Promise.resolve();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  flushChain = flushChain.catch(noop).then(doFlush);
  return flushChain;
}

/** `startup: "new"` promises to discard the previous session's unsaved text. */
export async function discardSession(session: SessionFile | null): Promise<void> {
  if (session) {
    await Promise.all(session.tabs.filter((t) => t.hasDraft).map((t) => ipc.draftDelete(t.id).catch(noop)));
  }
  await ipc.sessionWrite(JSON.stringify({ v: 1, activeId: "", tabs: [] }));
}

/** Clears what this run stored, once every dirty tab has been answered for. */
export async function discardCurrentSession(): Promise<void> {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  const ids = useApp.getState().tabs.filter((t) => rtOf(t.id).hasDraft).map((t) => t.id);
  await Promise.all(ids.map((id) => ipc.draftDelete(id).catch(noop)));
  await ipc.sessionWrite(JSON.stringify({ v: 1, activeId: "", tabs: [] }));
}
