// File I/O rules 2, 3, 6, 7, 8 and 9 of the spec: chunked loading, partial saves,
// external change polling, background scans, drafts, session and hibernation.
import { engine } from "../editor";
import { countCodePoints } from "../editor/charCount";
import type { CarriedDocState, ScrollSnapshot } from "../editor/api";
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
/** Above this a draft write is costly enough to wait longer for a pause (BUGS.md H8). */
const BIG_DRAFT_CHARS = 1024 * 1024;
const DRAFT_MS_PER_BIG = 2000;
const DRAFT_MAX_DEBOUNCE_MS = 30_000;
/** However long the typing goes on, a draft is never older than this. */
const DRAFT_MAX_WAIT_MS = 60_000;
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
  /** The user picked a line ending, so the next save writes it on every line. */
  eolChosen: boolean;
  /**
   * Set when a clean tab was flagged deleted: the editSeq at that moment. If the
   * file comes back before the user edits, the tab is clean again (BUGS.md H7).
   */
  cleanDelete: number | null;
  /** The file could not be read, so the editor does not hold its text: never save over it. */
  unreadable: boolean;
  /** Characters (code points) read from the file into the editor; null when unknown (restored draft). */
  diskChars: number | null;
  /** The file state a hibernated tab's kept undo history belongs to. */
  sleep: { stamp: FileStamp | null; encoding: Encoding } | null;
  /** The encoding the file was last read with (SaveRequest.originalEncoding). */
  diskEncoding: Encoding | null;
  /** The user was told the file looks binary. */
  binaryWarned: boolean;
  /** What the stored draft was written from (edits, length, file state); a flush skips an unchanged one (H8). */
  draftSig: string | null;
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
      eolChosen: false,
      cleanDelete: null,
      unreadable: false,
      sleep: null,
      diskChars: null,
      diskEncoding: null,
      binaryWarned: false,
      draftSig: null,
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

/** The stored unsaved text of a tab exists but could not be read. */
export class DraftUnreadableError extends Error {
  constructor(detail: string) {
    super(`The unsaved changes of this tab could not be read. They are kept, and Notepadly tries again when you switch to the tab.\n${detail}`);
  }
}

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
      if (!current) return;
      if (!current.fullyLoaded) {
        // A restored draft's loaded part is not a known slice of the file: estimate.
        const loaded = rt.diskChars ?? engine.charCount(id);
        patchTab(id, { tailChars: Math.max(0, result.chars - loaded) });
      }
      if (result.invalid && current.encoding === tab.encoding) onInvalidUtf8(id);
    })
    .catch(noop);
}

/**
 * The encoding comes from the first 256 KB only. When the whole-file scan finds
 * bytes further on that are not UTF-8, the file is really ANSI (BUGS.md C7):
 * an unedited tab is read again as ANSI, an edited one gets a warning.
 */
function onInvalidUtf8(id: string): void {
  const tab = getTab(id);
  if (!tab?.path || (tab.encoding !== "utf-8" && tab.encoding !== "utf-8-bom")) return;
  if (!tab.dirty && !tab.externalChange) {
    reopenWithEncoding(id, "ansi").catch((error) =>
      showMessage("Could not open file", `${tab.title} could not be read again as ANSI.\n${String(error)}`),
    );
    return;
  }
  showMessage(
    "File is not UTF-8",
    `Part of ${tab.title} is not valid UTF-8, so those characters show as � and would be saved that way. To read it correctly, reload it as ANSI from the Encoding menu in the status bar (your changes would be lost), or Save as to keep your text in a new file.`,
  );
}

/** Reads the file again from the start in the given encoding, replacing the tab's text. */
export function reopenWithEncoding(id: string, encoding: Encoding): Promise<void> {
  const rt = rtOf(id);
  return enqueue(rt, async () => {
    await settle(rt.materialising);
    const tab = getTab(id);
    if (!tab?.path) return;
    const snap = engine.hasDoc(id) ? engine.snapshot(id) : rt.snap;
    await applyFromDisk(id, reloadTarget(tab), snap, false, encoding);
  });
}

/** The user picked a line ending: the next save writes it on every line. */
export function markEolChosen(id: string): void {
  rtOf(id).eolChosen = true;
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
    const chunk = await ipc.readChunk(tab.path as string, offset, maxBytes, offset === 0 ? null : tab.encoding);
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
    if (chunk.binary) warnBinary(id);
    // Code points, as Rust's scan counts them (BUGS.md L5).
    const chunkChars = countCodePoints(chunk.text);
    if (rt.diskChars !== null) rt.diskChars += chunkChars;
    patchTab(id, {
      loadedOffset: chunk.nextOffset,
      fullyLoaded: chunk.eof,
      stamp: chunk.stamp,
      tailChars:
        chunk.eof || current.tailChars === null ? null : Math.max(0, current.tailChars - chunkChars),
      ...(chunk.mixedEol ? { mixedEol: true } : {}),
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
  mixedEol: boolean;
  readOnly: boolean;
  binary: boolean;
}

/** Reads from byte 0 to about `target`. Restarts if the file changes part way. */
async function readUpTo(
  path: string,
  target: number,
  isCurrent: () => boolean,
  forced: Encoding | null = null,
): Promise<DiskRead | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts: string[] = [];
    let offset = 0;
    let first: { stamp: FileStamp; encoding: Encoding; eol: Eol; readOnly: boolean } | null = null;
    let mixedEol = false;
    let binary = false;
    for (;;) {
      const wanted = Math.min(RELOAD_CHUNK, Math.max(MIN_READ, target - offset));
      const size = offset === 0 ? Math.max(FIRST_CHUNK, wanted) : wanted;
      const chunk = await ipc.readChunk(path, offset, size, first?.encoding ?? forced);
      if (!isCurrent()) return null;
      if (first && !stampsEqual(first.stamp, chunk.stamp)) {
        first = null;
        break;
      }
      first ??= { stamp: chunk.stamp, encoding: chunk.encoding, eol: chunk.eol, readOnly: !!chunk.readOnly };
      if (chunk.nextOffset <= offset && !chunk.eof) throw new Error("The file could not be read.");
      parts.push(chunk.text);
      mixedEol ||= !!chunk.mixedEol;
      binary ||= !!chunk.binary;
      offset = chunk.nextOffset;
      if (chunk.eof || target <= FIRST_CHUNK || offset >= target) {
        return { ...first, mixedEol, binary, text: parts.join(""), nextOffset: offset, eof: chunk.eof };
      }
    }
  }
  throw new Error("The file kept changing while it was being read.");
}

function restoreView(id: string, snap: ScrollSnapshot | null): void {
  if (!snap) return;
  const length = engine.length(id);
  engine.restore(id, {
    ...snap,
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
  forced: Encoding | null = null,
): Promise<void> {
  const rt = rtOf(id);
  const start = getTab(id);
  if (!start?.path) return;
  const gen = ++rt.gen;
  rt.ioSeq++;
  cancelIdleLoad(rt);
  await settle(rt.inFlight);
  const editsAtStart = rt.editSeq;
  const read = await readUpTo(start.path, target, () => rt.gen === gen && !!getTab(id), forced);
  const tab = getTab(id);
  if (!read || !tab || rt.gen !== gen) return;
  if (silent && (rt.editSeq !== editsAtStart || tab.dirty)) {
    // The user started typing while the read was out: their text wins.
    patchTab(id, { externalChange: "modified" });
    return;
  }
  const sleep = rt.sleep;
  rt.sleep = null;
  if (engine.hasDoc(id)) engine.resetDoc(id, read.text);
  else if (sleep && stampsEqual(sleep.stamp, read.stamp) && sleep.encoding === read.encoding) {
    // Unchanged on disk, so the text read again starts with the text it had: keep its undo.
    engine.wakeDoc(id, read.text, tab.mode);
  } else engine.createDoc(id, read.text, tab.mode);
  restoreView(id, snap);
  patchTab(id, {
    stamp: read.stamp,
    eol: read.eol,
    encoding: read.encoding,
    loadedOffset: read.nextOffset,
    fullyLoaded: read.eof,
    tailChars: null,
    dirty: false,
    externalChange: null,
    hibernated: false,
    mixedEol: read.mixedEol,
    readOnly: read.readOnly,
  });
  rt.forceDirty = false;
  // The editor matches the file again: a line ending picked before is gone with the edits.
  rt.eolChosen = false;
  rt.cleanDelete = null;
  rt.unreadable = false;
  rt.dismissed = null;
  rt.scanStarted = false;
  rt.diskChars = countCodePoints(read.text);
  rt.diskEncoding = read.encoding;
  if (read.binary) warnBinary(id);
  rt.ioSeq++;
  rt.snap = null;
  markDraftChanged(id);
  if (!read.eof) {
    startScan(id);
    scheduleIdleLoad(id);
  }
}

/** Once per tab: a file with NUL characters is probably not text, and a save can damage it (M15). */
function warnBinary(id: string): void {
  const rt = rtOf(id);
  const tab = getTab(id);
  if (rt.binaryWarned || !tab) return;
  rt.binaryWarned = true;
  showMessage(
    "File looks binary",
    `${tab.title} contains NUL characters, so it is probably not a text file. Saving it from Notepadly can damage it.`,
  );
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
      let draft: string | null;
      try {
        draft = await ipc.draftRead(id);
      } catch (error) {
        // Not missing but unreadable (locked, access denied): the draft is kept,
        // and the tab stays without editor state until it can be read (L16).
        throw new DraftUnreadableError(String(error));
      }
      if (!getTab(id) || engine.hasDoc(id)) return;
      if (draft !== null) {
        engine.createDoc(id, draft, tab.mode);
        rt.diskChars = null;
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
    if (error instanceof DraftUnreadableError) {
      // No editor state: nothing can be typed over it, and drafts are never
      // written or deleted for it, so the stored text stays as it is.
      showMessage("Could not restore unsaved changes", `${tab.title}: ${error.message}`);
      return;
    }
    const disk = tab.path ? await ipc.stat(tab.path).catch(() => undefined) : undefined;
    if (!getTab(id) || engine.hasDoc(id)) return;
    engine.createDoc(id, "", tab.mode);
    const rt = rtOf(id);
    if (disk === null) {
      // Nothing was loaded, so there is no text to lose: the tab stays clean and
      // the bar says the file is gone. Saving an empty tab must not create an
      // empty file (BUGS.md H16); typing something and saving recreates it.
      rt.forceDirty = false;
      patchTab(id, { hibernated: false, dirty: false, externalChange: "deleted", fullyLoaded: true, stamp: null });
      markDraftChanged(id);
    } else {
      // The empty editor does not show the file, so it must not be saved over it
      // (BUGS.md M22). With no stamp, polling retries the read for a clean tab.
      rt.unreadable = true;
      patchTab(id, {
        hibernated: false,
        externalChange: "modified",
        loadedOffset: 0,
        fullyLoaded: false,
        stamp: null,
      });
      showMessage("Could not open file", `${tab.title} could not be read.\n${String(error)}`);
    }
  }
}

// ---- Saving ----------------------------------------------------------------

export type WriteResult = { ok: true } | { ok: false; stale: boolean; message: string };

export interface WriteOptions {
  /**
   * Writes only the loaded text of a partly loaded tab to another path, and
   * makes the tab that new, complete file. For a file whose rest can no longer
   * be read because it changed on disk.
   */
  loadedOnly?: boolean;
  /** Lets characters the ANSI code page lacks be saved as `?`. */
  allowLossy?: boolean;
}

/** Serialised with loads and reloads, so byte offsets can never be read mid-rewrite. */
export function writeTab(id: string, targetPath: string, options: WriteOptions = {}): Promise<WriteResult> {
  const rt = rtOf(id);
  return enqueue(rt, () => doWrite(id, rt, targetPath, options));
}

/** Waits for any queued save or reload of this tab. */
export const settleTabIo = (id: string): Promise<void> => rtOf(id).queue;

async function doWrite(id: string, rt: TabRuntime, targetPath: string, options: WriteOptions): Promise<WriteResult> {
  await settle(rt.inFlight);
  try {
    await materialise(id);
  } catch (error) {
    return { ok: false, stale: false, message: String(error) };
  }
  const tab = getTab(id);
  if (!tab) return { ok: false, stale: false, message: "The tab was closed." };
  if (rt.unreadable) {
    return {
      ok: false,
      stale: false,
      message: "This file could not be read, so this tab does not show its text. Reload it before saving.",
    };
  }
  const samePath = pathsEqual(tab.path, targetPath);
  const loadedOnly = !!options.loadedOnly && !samePath;
  const partial = !tab.fullyLoaded && !loadedOnly;
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
      allowLossy: !!options.allowLossy,
      // Mixed line endings are only kept when rewriting the same file.
      normalizeEol: rt.eolChosen || !samePath,
      ...(samePath && rt.diskEncoding ? { originalEncoding: rt.diskEncoding } : {}),
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
  rt.cleanDelete = null;
  rt.dismissed = null;
  const normalized = rt.eolChosen || !samePath;
  rt.eolChosen = false;
  rt.diskEncoding = tab.encoding;
  const shared = {
    path: targetPath,
    title: fileNameOf(targetPath),
    stamp,
    dirty: !unchanged,
    externalChange: null,
    // Written just now, so writable; every line got one ending unless kept.
    readOnly: false,
    ...(normalized ? { mixedEol: false } : {}),
  };
  if (tailOffset === null) {
    patchTab(id, { ...shared, loadedOffset: stamp.size, fullyLoaded: true, tailChars: null });
  } else {
    const next = loadedOffsetAfterPartialSave(stamp.size, oldSize, tailOffset);
    if (next === null) {
      // Cannot happen if Rust wrote text + tail. Re-reading stays correct, but costs the undo stack.
      patchTab(id, shared);
      await applyFromDisk(id, tailOffset, engine.snapshot(id), false);
    } else {
      patchTab(id, { ...shared, loadedOffset: next, tailChars: null });
      rt.diskChars = countCodePoints(text);
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
    rt.cleanDelete = null;
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

/** What a tab moving to another window takes with it besides its TabMeta (F2). */
export interface TabHandoff {
  /** The loaded text; null when the tab has no editor state (it loads there). */
  text: string | null;
  snap: ScrollSnapshot | null;
  hasDraft: boolean;
  draftMeta: DraftMeta | null;
  forceDirty: boolean;
  // The runtime state below must move too (STATE-6). Optional for a transfer
  // from a window that runs an older build.
  /** A change on disk the user chose to ignore ("Keep mine"). */
  dismissed?: DismissedChange;
  /** A line ending was picked, so the next save writes it on every line. */
  eolChosen?: boolean;
  /** A clean tab flagged deleted and not edited since: clean again if the file comes back (H7). */
  cleanDelete?: boolean;
  /** The file could not be read, so the text is not the file's: never save over it (M22). */
  unreadable?: boolean;
  /** The file state a hibernated tab's undo history belongs to. */
  sleep?: { stamp: FileStamp | null; encoding: Encoding } | null;
  /** Characters read from the file into the editor (L5). */
  diskChars?: number | null;
  /** Undo history (when not too big) and callout folds (F2). */
  editor?: CarriedDocState | null;
}

/** Read together with the tab's TabMeta, in the same tick, so offsets match the text. */
export function handOff(id: string): TabHandoff {
  const rt = rtOf(id);
  const hasDoc = engine.hasDoc(id);
  return {
    text: hasDoc ? engine.getText(id) : null,
    snap: hasDoc ? engine.snapshot(id) : rt.snap,
    hasDraft: rt.hasDraft,
    draftMeta: rt.draftMeta,
    forceDirty: rt.forceDirty,
    dismissed: rt.dismissed,
    eolChosen: rt.eolChosen,
    cleanDelete: rt.cleanDelete !== null && rt.cleanDelete === rt.editSeq,
    unreadable: rt.unreadable,
    sleep: rt.sleep,
    diskChars: rt.diskChars,
    editor: engine.carryState?.(id) ?? null,
  };
}

/**
 * Takes over a tab handed off by another window. `tab` is already in the store,
 * under a new id (STATE-5): `fromId` is the id it had there. Nothing is read
 * from the file or saved: the text arrives as it was and unsaved edits stay
 * unsaved. A tab with no editor state gets a copy of its draft under the new id,
 * so the two windows never share one draft. Rejects when that copy fails; the
 * tab must then not be kept here.
 */
export async function takeOver(tab: TabMeta, handoff: TabHandoff, fromId: string = tab.id): Promise<void> {
  const rt = rtOf(tab.id);
  rt.snap = handoff.snap;
  rt.dismissed = handoff.dismissed ?? null;
  rt.eolChosen = !!handoff.eolChosen;
  rt.unreadable = !!handoff.unreadable;
  rt.sleep = handoff.sleep ?? null;
  rt.diskChars = handoff.diskChars ?? null;
  const carried = handoff.editor ?? null;
  if (handoff.text !== null) {
    // With its undo history, the editor knows the saved point and so whether the tab is dirty.
    const withHistory =
      !!carried && !!engine.adoptDoc && engine.adoptDoc(tab.id, handoff.text, tab.mode, carried);
    if (!withHistory) engine.createDoc(tab.id, handoff.text, tab.mode);
    restoreView(tab.id, handoff.snap);
    rt.snap = null;
    // A new editor state without history starts clean; the tab is not.
    rt.forceDirty = handoff.forceDirty || (tab.dirty && !withHistory);
    rt.cleanDelete = handoff.cleanDelete ? rt.editSeq : null;
    if (!tab.fullyLoaded) {
      startScan(tab.id);
      scheduleIdleLoad(tab.id);
    }
    // The draft is written under the new id by the next flush.
    if (tab.dirty) markDraftChanged(tab.id);
  } else if (handoff.hasDraft && tab.dirty) {
    if (fromId !== tab.id) {
      const draft = await ipc.draftRead(fromId);
      if (draft === null) throw new Error("The unsaved text of this tab could not be found.");
      await ipc.draftWrite(tab.id, draft);
    }
    rt.hasDraft = true;
    rt.draftMeta = handoff.draftMeta;
  } else if (carried && rt.sleep) {
    // Hibernated: its history waits in the engine for the wake (M12).
    engine.adoptDoc?.(tab.id, null, tab.mode, carried);
  }
  scheduleSessionWrite();
}


export function registerRestored(session: SessionTab): void {
  const rt = rtOf(session.id);
  rt.snap = session.snap;
  rt.hasDraft = session.hasDraft;
  rt.eolChosen = !!session.eolChosen;
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
  if (disk && current.externalChange === "deleted" && rt.cleanDelete === rt.editSeq) {
    // The file came back (git checkout, OneDrive, save by delete + rename) and the
    // user typed nothing meanwhile: the deletion was the only reason for the dirty mark.
    rt.cleanDelete = null;
    rt.forceDirty = false;
    patchTab(tab.id, { dirty: false });
    markDraftChanged(tab.id);
    if (stampsEqual(disk, current.stamp)) patchTab(tab.id, { externalChange: null });
    else if (hasDoc) silentReload(tab.id).catch(noop);
    else patchTab(tab.id, { stamp: disk, externalChange: null });
    return;
  }
  switch (decideExternal(current, disk, rt.dismissed, hasDoc)) {
    case "flag-modified":
      rt.dismissed = null;
      patchTab(tab.id, { externalChange: "modified" });
      break;
    case "flag-deleted":
      rt.cleanDelete = current.dirty ? null : rt.editSeq;
      if (!hasDoc) {
        // Not loaded (restored lazily or hibernated): no text here that only this
        // tab holds, so there is nothing to save and closing must not ask (STATE-1).
        patchTab(tab.id, { externalChange: "deleted" });
        break;
      }
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
    rt.sleep = { stamp: tab.stamp, encoding: tab.encoding };
    engine.hibernate(tab.id);
    patchTab(tab.id, { hibernated: true });
  }
}

export function startHibernation(): void {
  setInterval(hibernateSweep, HIBERNATE_SWEEP_MS);
}

// ---- Drafts and session ------------------------------------------------------

let persistence = false;
/** Which stored window session this window writes; null is the old single session.json. */
let sessionKey: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** When the oldest change not yet written was made. */
let pendingSince: number | null = null;
let flushChain: Promise<void> = Promise.resolve();
const changedDrafts = new Set<string>();

/** Each window stores its own session under its key (C5, M18). */
export function setSessionKey(key: string | null): void {
  sessionKey = key;
}

export const getSessionKey = (): string | null => sessionKey;

function writeSession(json: string): Promise<void> {
  return sessionKey === null ? ipc.sessionWrite(json) : ipc.windowSessionWrite(sessionKey, json);
}

/** On in every window while `startup` is "continue". */
export function setPersistence(enabled: boolean): void {
  if (enabled === persistence) return;
  persistence = enabled;
  if (enabled) {
    for (const tab of useApp.getState().tabs) if (tab.dirty) changedDrafts.add(tab.id);
    scheduleFlush();
  }
}

/**
 * The typing pause to wait for before writing drafts of this many characters. A
 * draft is the whole text, so a big document waits for a longer pause.
 */
export function draftDelay(chars: number): number {
  if (chars <= BIG_DRAFT_CHARS) return DRAFT_DEBOUNCE_MS;
  return Math.min(DRAFT_MAX_DEBOUNCE_MS, Math.round(DRAFT_DEBOUNCE_MS + (chars / BIG_DRAFT_CHARS) * DRAFT_MS_PER_BIG));
}

function pendingDraftChars(): number {
  let largest = 0;
  for (const id of changedDrafts) {
    if (getTab(id)?.dirty && engine.hasDoc(id)) largest = Math.max(largest, engine.length(id));
  }
  return largest;
}

function scheduleFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  const now = Date.now();
  pendingSince ??= now;
  const delay = Math.max(0, Math.min(draftDelay(pendingDraftChars()), pendingSince + DRAFT_MAX_WAIT_MS - now));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPersistence().catch((error) => console.error("Notepadly: session write failed", error));
  }, delay);
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
        ...(rt.eolChosen ? { eolChosen: true } : {}),
        ...(tab.mixedEol ? { mixedEol: true } : {}),
      };
    }),
  };
}

/** Bumped when the session is cleared, so a flush still running then does not store it again. */
let discards = 0;

async function doFlush(): Promise<void> {
  const discardsAtStart = discards;
  const ids = [...changedDrafts];
  changedDrafts.clear();
  pendingSince = null;
  let failure: unknown = null;
  for (const id of ids) {
    const tab = getTab(id);
    if (!tab) continue;
    const rt = rtOf(id);
    try {
      if (tab.dirty) {
        if (!engine.hasDoc(id)) continue;
        const meta = { stamp: tab.stamp, loadedOffset: tab.loadedOffset, fullyLoaded: tab.fullyLoaded };
        // The whole text crosses IPC for each draft: not again when nothing changed (H8).
        const sig = `${rt.editSeq}:${engine.length(id)}:${tab.loadedOffset}:${tab.stamp?.size}:${tab.stamp?.mtimeMs}`;
        if (rt.hasDraft && rt.draftSig === sig) continue;
        await ipc.draftWrite(id, engine.getText(id));
        rt.hasDraft = true;
        rt.draftMeta = meta;
        rt.draftSig = sig;
      } else if (rt.hasDraft) {
        await ipc.draftDelete(id);
        rt.hasDraft = false;
        rt.draftMeta = null;
        rt.draftSig = null;
      }
    } catch (error) {
      failure = error;
      changedDrafts.add(id);
    }
  }
  if (discards !== discardsAtStart) return;
  await writeSession(JSON.stringify(buildSession()));
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

/**
 * Deletes drafts no tab owns (left by a crash or a corrupt session, BUGS.md L16).
 * Runs on the flush chain, so a draft written by this run is never pruned.
 */
/** `alsoKeep`: drafts owned by other windows' stored sessions. */
export function pruneDrafts(alsoKeep: string[] = []): Promise<void> {
  const run = flushChain.catch(noop).then(() => {
    const keep = [...useApp.getState().tabs.filter((t) => rtOf(t.id).hasDraft).map((t) => t.id), ...alsoKeep];
    return ipc.draftsPrune(keep);
  });
  flushChain = run.catch(noop);
  return run;
}

/** `startup: "new"` promises to discard the previous session's unsaved text. */
export async function discardSession(session: SessionFile | null): Promise<void> {
  if (session) {
    await Promise.all(session.tabs.filter((t) => t.hasDraft).map((t) => ipc.draftDelete(t.id).catch(noop)));
  }
  await ipc.sessionWrite(JSON.stringify({ v: 1, activeId: "", tabs: [] }));
}

/** How long a close waits for a draft write already running before it clears the session anyway. */
const DISCARD_WAIT_MS = 5000;

/** Clears what this run stored, once every dirty tab has been answered for. */
export function discardCurrentSession(): Promise<void> {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  pendingSince = null;
  changedDrafts.clear();
  discards++;
  // On the flush chain: a flush already writing would otherwise store the
  // session and drafts again after they were deleted (STATE-2).
  // A draft write that never returns must not keep the window open for good.
  const running = Promise.race([
    flushChain.catch(noop),
    new Promise<void>((resolve) => setTimeout(resolve, DISCARD_WAIT_MS)),
  ]);
  const run = running.then(async () => {
    const ids = useApp.getState().tabs.filter((t) => rtOf(t.id).hasDraft).map((t) => t.id);
    await Promise.all(ids.map((id) => ipc.draftDelete(id).catch(noop)));
    if (sessionKey === null) await ipc.sessionWrite(JSON.stringify({ v: 1, activeId: "", tabs: [] }));
    else await ipc.windowSessionDelete(sessionKey);
  });
  flushChain = run.catch(noop);
  return run;
}
