// CodeMirror engine: one EditorView, one EditorState per tab.
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  isolateHistory,
  redo,
  redoDepth,
  redoSelection,
  selectAll,
  toggleTabFocusMode,
  undo,
  undoDepth,
  undoSelection,
} from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
  type Extension,
  type StateEffect,
} from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import type {
  CursorInfo,
  EditorConfig,
  EditorEngine,
  EditorHost,
  FindQuery,
  FindResult,
  FormatCommand,
  FormatContext,
  FormatMode,
  ScrollSnapshot,
} from "./api";
import {
  applyFormat,
  continueMarkup,
  deleteMarkerBackward,
  formatContextAt,
  handleShiftTab,
  handleTab,
} from "./commands";
import { FIND_COUNT_LIMIT, FindController, findExtension } from "./find";
import { blockPreview, rebuildBlocks } from "./livePreview/block";
import { previewContext, resolveHref } from "./livePreview/context";
import { ctrlClick, inlinePreview } from "./livePreview/inline";
import { escapeCellText, focusedTable, tableAt } from "./livePreview/widgets";
import { markdownSupport, parseAhead } from "./markdown";
import { editorRootClass, lineDirections, tokenClasses, watchTheme } from "./theme";
import { wheelZoomHandler } from "./wheelZoom";
import "./editor.css";

export { FIND_COUNT_LIMIT };

const MAX_LINE_FOR_PREVIEW = 20000;
const MAX_DOC_FOR_PREVIEW = 20 * 1024 * 1024;
const NEAR_END_THROTTLE_MS = 120;
/** Wait after an edit that shortened a degraded document before checking it again. */
const RECHECK_DELAY_MS = 400;
/** History keeps at least this many undo steps; trackHistory follows its trimming. */
const HISTORY_DEPTH = 400;

const loadingText = Annotation.define<boolean>();

const modeCompartment = new Compartment();
const wrapCompartment = new Compartment();
const attributesCompartment = new Compartment();

const modeClass = (name: string) => EditorView.editorAttributes.of({ class: `cm-mode-${name}` });

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/** The web address under `offset` in a line of plain text, without trailing punctuation. */
export function urlAt(lineText: string, offset: number): string | null {
  for (const match of lineText.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
    const from = match.index ?? 0;
    if (offset >= from && offset <= from + url.length) return url;
  }
  return null;
}

/** Plain text has no syntax tree: Ctrl+click opens a bare web address (BUGS.md L13). */
const plainLinkClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!event.ctrlKey || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const line = view.state.doc.lineAt(pos);
    if (line.length > 20000) return false;
    const url = urlAt(line.text, pos - line.from);
    if (!url) return false;
    event.preventDefault();
    previewContext.openLink(resolveHref(url));
    return true;
  },
});

const modeExtensions: Record<FormatMode, Extension> = {
  formatted: [modeClass("formatted"), markdownSupport, parseAhead, tokenClasses, blockPreview, inlinePreview],
  // Ctrl+click on links works in every mode, not only Formatted (BUGS.md L13).
  syntax: [modeClass("syntax"), markdownSupport, parseAhead, tokenClasses, ctrlClick],
  plain: [modeClass("plain"), plainLinkClick],
};

interface DocRecord {
  id: string;
  /** Stale while the tab is active: use `stateOf`. */
  state: EditorState;
  mode: FormatMode;
  /** The document is too large, or has a line too long, for live preview. */
  degraded: boolean;
  /** Version id for each undo depth; dirty means the current id is not the saved one. */
  versions: number[];
  depth: number;
  savedVersion: number;
  dirty: boolean;
  scrollEffect: StateEffect<unknown> | null;
  scrollTop: number | null;
  configSerial: number;
}

/** What a hibernated tab keeps so its undo history survives (BUGS.md M12). */
interface SleepRecord {
  /** The history field's value: undo events as changes against a doc of `length`, no text. */
  history: unknown;
  length: number;
  versions: number[];
  depth: number;
  savedVersion: number;
}

let versionCounter = 0;

/** Whether a document still needs the plain fallback; walks lines without joining the text. */
function needsDegrade(doc: EditorState["doc"]): boolean {
  if (doc.length > MAX_DOC_FOR_PREVIEW) return true;
  if (doc.length <= MAX_LINE_FOR_PREVIEW) return false;
  for (let iter = doc.iterLines(); !iter.next().done; ) {
    if (iter.value.length > MAX_LINE_FOR_PREVIEW) return true;
  }
  return false;
}

function hasLongLine(text: string): boolean {
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end < 0) return text.length - start > MAX_LINE_FOR_PREVIEW;
    if (end - start > MAX_LINE_FOR_PREVIEW) return true;
    start = end + 1;
  }
}

function sameFormatContext(a: FormatContext | null, b: FormatContext): boolean {
  return (
    !!a &&
    a.block === b.block &&
    a.list === b.list &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.link === b.link &&
    a.inTable === b.inTable
  );
}

function clampZoom(zoom: number): number {
  return Math.min(500, Math.max(10, zoom));
}

class Engine implements EditorEngine {
  private view: EditorView | null = null;
  private host: EditorHost | null = null;
  private config: EditorConfig = {
    wordWrap: true,
    zoom: 100,
    fontFamily: "",
    fontWeight: 400,
    fontSizePt: 11,
    spellcheck: false,
    autocorrect: false,
  };
  private configSerial = 0;
  private readonly docs = new Map<string, DocRecord>();
  private readonly sleeping = new Map<string, SleepRecord>();
  private activeId: string | null = null;
  private readonly finder = new FindController(() => this.view);

  private cursorFrame = 0;
  private lastContext: FormatContext | null = null;
  private lastNearEnd = 0;
  private nearEndTimer = 0;
  private recheckTimer = 0;
  private disposers: (() => void)[] = [];

  // ---------- Lifecycle ----------

  mount(parent: HTMLElement, host: EditorHost, config: EditorConfig): void {
    this.destroy();
    this.host = host;
    this.config = { ...config, zoom: clampZoom(config.zoom) };
    this.configSerial++;
    previewContext.baseDir = () => (this.activeId ? host.baseDir(this.activeId) : null);
    previewContext.openLink = (href) => host.openLink(href);

    const view = new EditorView({ parent, state: this.placeholderState() });
    this.view = view;
    this.applyCssVariables();

    // One zoom step per notch's worth of movement, not per event: a pinch sends dozens.
    const onWheel = wheelZoomHandler((direction) => host.onZoomDelta(direction * 10));
    view.dom.addEventListener("wheel", onWheel, { passive: false });
    const stopWatching = watchTheme(view.dom, () => {
      this.view?.dispatch({ effects: rebuildBlocks.of(null) });
    });
    this.disposers = [() => view.dom.removeEventListener("wheel", onWheel), stopWatching];
  }

  destroy(): void {
    if (this.cursorFrame) cancelAnimationFrame(this.cursorFrame);
    this.cursorFrame = 0;
    clearTimeout(this.nearEndTimer);
    this.nearEndTimer = 0;
    clearTimeout(this.recheckTimer);
    this.recheckTimer = 0;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.view?.destroy();
    this.view = null;
    this.host = null;
    this.activeId = null;
    this.docs.clear();
    this.sleeping.clear();
  }

  // ---------- State construction ----------

  private wrapExtension(): Extension {
    return this.config.wordWrap ? EditorView.lineWrapping : [];
  }

  private attributesExtension(): Extension {
    return EditorView.contentAttributes.of({
      spellcheck: this.config.spellcheck ? "true" : "false",
      autocorrect: this.config.autocorrect ? "on" : "off",
      autocapitalize: "off",
    });
  }

  private keymapExtension(): Extension {
    const format = (command: FormatCommand) => (view: EditorView) => {
      if (this.activeDoc()?.mode === "plain") return false;
      applyFormat(view, command);
      return true;
    };
    return [
      Prec.high(
        keymap.of([
          { key: "Enter", run: continueMarkup },
          { key: "Backspace", run: deleteMarkerBackward },
          { key: "Tab", run: handleTab, shift: handleShiftTab },
          { key: "Mod-b", run: format({ type: "bold" }), preventDefault: true },
          { key: "Mod-i", run: format({ type: "italic" }), preventDefault: true },
        ]),
      ),
      // Mod-i is italic; Ctrl+M (tab focus mode) made Tab leave the editor with no sign (BUGS.md M3).
      // historyKeymap also binds Ctrl+U / Alt+U (undo/redo selection), which Notepad does not have.
      keymap.of([
        ...historyKeymap.filter((binding) => binding.run !== undoSelection && binding.run !== redoSelection),
        ...defaultKeymap.filter((binding) => binding.key !== "Mod-i" && binding.run !== toggleTabFocusMode),
      ]),
    ];
  }

  /** What the view shows when no tab's document is active: empty, and closed to typing. */
  private placeholderState(): EditorState {
    return EditorState.create({
      doc: "",
      extensions: [this.stateExtensions("plain"), EditorState.readOnly.of(true), EditorView.editable.of(false)],
    });
  }

  private createState(text: string, mode: FormatMode): EditorState {
    return EditorState.create({ doc: text, extensions: this.stateExtensions(mode) });
  }

  private stateExtensions(mode: FormatMode): Extension {
    return [
        editorRootClass,
        history({ minDepth: HISTORY_DEPTH, newGroupDelay: 500 }),
        lineDirections,
        EditorState.tabSize.of(4),
        modeCompartment.of(modeExtensions[mode]),
        wrapCompartment.of(this.wrapExtension()),
        attributesCompartment.of(this.attributesExtension()),
        findExtension,
        this.keymapExtension(),
        EditorView.updateListener.of((update) => this.onUpdate(update)),
    ];
  }

  private effectiveMode(doc: DocRecord): FormatMode {
    return doc.mode === "formatted" && doc.degraded ? "syntax" : doc.mode;
  }

  private newRecord(id: string, text: string, mode: FormatMode): DocRecord {
    const degraded = text.length > MAX_DOC_FOR_PREVIEW || hasLongLine(text);
    const effective = mode === "formatted" && degraded ? "syntax" : mode;
    const version = ++versionCounter;
    return {
      id,
      state: this.createState(text, effective),
      mode,
      degraded,
      versions: [version],
      depth: 0,
      savedVersion: version,
      dirty: false,
      scrollEffect: null,
      scrollTop: null,
      configSerial: this.configSerial,
    };
  }

  private activeDoc(): DocRecord | null {
    return this.activeId ? (this.docs.get(this.activeId) ?? null) : null;
  }

  private stateOf(doc: DocRecord): EditorState {
    return doc.id === this.activeId && this.view ? this.view.state : doc.state;
  }

  private withConfig(state: EditorState, doc: DocRecord): EditorState {
    if (doc.configSerial === this.configSerial) return state;
    doc.configSerial = this.configSerial;
    return state.update({
      effects: [
        wrapCompartment.reconfigure(this.wrapExtension()),
        attributesCompartment.reconfigure(this.attributesExtension()),
      ],
    }).state;
  }

  // ---------- Update handling ----------

  private onUpdate(update: ViewUpdate): void {
    const doc = this.activeDoc();
    if (!doc) return;

    if (update.docChanged) {
      const userEdit = update.transactions.some((tr) => tr.docChanged && !tr.annotation(loadingText));
      if (userEdit) {
        for (const tr of update.transactions) this.trackHistory(doc, tr);
        this.refreshDirty(doc);
        this.host?.onDocChange(doc.id);
      }
      this.checkDegrade(doc, update);
    }
    if (update.docChanged || update.selectionSet) this.scheduleCursor();
    if (update.docChanged || update.viewportChanged || update.geometryChanged) this.checkNearEnd();
  }

  private trackHistory(doc: DocRecord, tr: Transaction): void {
    if (!tr.docChanged || tr.annotation(Transaction.addToHistory) === false) return;
    const depth = undoDepth(tr.state);
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) {
      doc.depth = depth;
      if (doc.versions[depth] === undefined) doc.versions[depth] = ++versionCounter;
      return;
    }
    const before = undoDepth(tr.startState);
    if (depth < before) {
      // The history dropped its oldest events to stay near HISTORY_DEPTH (it never
      // does that when joining an event). A new event sits at before + 1, so the
      // difference is the number of trimmed steps: shift the versions down with them.
      // A saved point among the trimmed steps can no longer be reached by undo.
      doc.versions = doc.versions.slice(before + 1 - depth);
    }
    doc.versions.length = Math.min(doc.versions.length, depth);
    doc.versions[depth] = ++versionCounter;
    doc.depth = depth;
  }

  private refreshDirty(doc: DocRecord): void {
    const dirty = doc.versions[doc.depth] !== doc.savedVersion;
    if (dirty !== doc.dirty) {
      doc.dirty = dirty;
      this.host?.onDirtyChange(doc.id, dirty);
    }
  }

  private checkDegrade(doc: DocRecord, update: ViewUpdate): void {
    if (doc.mode !== "formatted") return;
    if (doc.degraded) {
      // Deleting the long line (or undoing its paste) brings live preview back.
      let removed = false;
      update.changes.iterChangedRanges((fromA, toA) => {
        if (toA > fromA) removed = true;
      });
      if (removed) this.scheduleRecheck(doc);
      return;
    }
    const { state } = update;
    let degrade = state.doc.length > MAX_DOC_FOR_PREVIEW;
    if (!degrade) {
      update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        if (degrade) return;
        if (state.doc.lineAt(fromB).length > MAX_LINE_FOR_PREVIEW) degrade = true;
        else if (state.doc.lineAt(toB).length > MAX_LINE_FOR_PREVIEW) degrade = true;
        else if (toB - fromB > MAX_LINE_FOR_PREVIEW && hasLongLine(state.sliceDoc(fromB, toB))) degrade = true;
      });
    }
    if (!degrade) return;
    doc.degraded = true;
    queueMicrotask(() => {
      if (this.activeId === doc.id && this.view) {
        this.view.dispatch({ effects: modeCompartment.reconfigure(modeExtensions.syntax) });
      }
    });
  }

  /** Debounced: a full line scan runs once after a burst of deletions, not per keystroke. */
  private scheduleRecheck(doc: DocRecord): void {
    clearTimeout(this.recheckTimer);
    this.recheckTimer = window.setTimeout(() => {
      this.recheckTimer = 0;
      const view = this.view;
      if (!view || this.activeId !== doc.id || !doc.degraded || doc.mode !== "formatted") return;
      if (needsDegrade(view.state.doc)) return;
      doc.degraded = false;
      view.dispatch({ effects: modeCompartment.reconfigure(modeExtensions.formatted) });
      this.scheduleCursor();
    }, RECHECK_DELAY_MS);
  }

  private scheduleCursor(): void {
    if (this.cursorFrame) return;
    this.cursorFrame = requestAnimationFrame(() => {
      this.cursorFrame = 0;
      this.emitCursor();
    });
  }

  private emitCursor(): void {
    const doc = this.activeDoc();
    const view = this.view;
    if (!doc || !view || !this.host) return;
    const { state } = view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    let selected = 0;
    for (const range of state.selection.ranges) selected += range.to - range.from;
    const info: CursorInfo = {
      line: line.number,
      col: head - line.from + 1,
      chars: state.doc.length,
      selected,
      canUndo: undoDepth(state) > 0,
      canRedo: redoDepth(state) > 0,
      previewLimited: doc.mode === "formatted" && doc.degraded,
    };
    this.host.onCursor(doc.id, info);
    if (doc.mode === "plain") return;
    const context = formatContextAt(state);
    if (!sameFormatContext(this.lastContext, context)) {
      this.lastContext = context;
      this.host.onFormatContext(doc.id, context);
    }
  }

  private checkNearEnd(): void {
    const now = performance.now();
    const wait = NEAR_END_THROTTLE_MS - (now - this.lastNearEnd);
    if (wait <= 0) {
      this.lastNearEnd = now;
      this.runNearEnd();
    } else if (!this.nearEndTimer) {
      this.nearEndTimer = window.setTimeout(() => {
        this.nearEndTimer = 0;
        this.lastNearEnd = performance.now();
        this.runNearEnd();
      }, wait);
    }
  }

  private runNearEnd(): void {
    const view = this.view;
    const doc = this.activeDoc();
    if (!view || !doc || !this.host) return;
    // Height-map queries only: no layout read, and no cost that grows with the document.
    const remaining = view.contentHeight - view.lineBlockAt(view.viewport.to).bottom;
    if (remaining <= window.innerHeight * 2) this.host.onNearEnd(doc.id);
  }

  private applyCssVariables(): void {
    const view = this.view;
    if (!view) return;
    const { style } = view.dom;
    const { fontFamily, fontSizePt, fontWeight, zoom } = this.config;
    const px = (fontSizePt * 4) / 3;
    style.setProperty("--nl-font-family", fontFamily || "inherit");
    style.setProperty("--nl-font-weight", String(fontWeight));
    style.setProperty("--nl-font-size", `${((px * clampZoom(zoom)) / 100).toFixed(3)}px`);
    view.requestMeasure();
  }

  private notifyActivated(doc: DocRecord): void {
    this.lastContext = null;
    this.scheduleCursor();
    this.checkNearEnd();
    if (doc.dirty) this.host?.onDirtyChange(doc.id, true);
  }

  // ---------- Documents ----------

  createDoc(tabId: string, text: string, mode: FormatMode): void {
    this.sleeping.delete(tabId);
    this.docs.set(tabId, this.newRecord(tabId, text, mode));
  }

  hibernate(tabId: string): void {
    const doc = this.docs.get(tabId);
    if (!doc) return;
    const state = this.stateOf(doc);
    this.dropDoc(tabId);
    this.sleeping.set(tabId, {
      history: state.field(historyField, false) ?? null,
      length: state.doc.length,
      versions: doc.versions,
      depth: doc.depth,
      savedVersion: doc.savedVersion,
    });
  }

  wakeDoc(tabId: string, text: string, mode: FormatMode): boolean {
    const sleep = this.sleeping.get(tabId);
    this.createDoc(tabId, text, mode);
    if (!sleep || sleep.history === null || text.length < sleep.length) return false;
    const doc = this.docs.get(tabId) as DocRecord;
    try {
      // The same mechanism EditorState.fromJSON uses to seed a field.
      let state = EditorState.create({
        doc: text.slice(0, sleep.length),
        extensions: [historyField.init(() => sleep.history), this.stateExtensions(this.effectiveMode(doc))],
      });
      if (text.length > sleep.length) {
        // Text loaded past the old end maps the history like a lazily appended chunk.
        state = state.update({
          changes: { from: sleep.length, insert: text.slice(sleep.length) },
          annotations: [Transaction.addToHistory.of(false), loadingText.of(true)],
        }).state;
      }
      doc.state = state;
    } catch {
      return false;
    }
    doc.versions = sleep.versions;
    doc.depth = sleep.depth;
    doc.savedVersion = sleep.savedVersion;
    doc.dirty = doc.versions[doc.depth] !== doc.savedVersion;
    return true;
  }

  appendText(tabId: string, text: string): void {
    const doc = this.docs.get(tabId);
    if (!doc || !text) return;
    const state = this.stateOf(doc);
    const length = state.doc.length;
    const firstBreak = text.indexOf("\n");
    const joinedLine = state.doc.lineAt(length).length + (firstBreak < 0 ? text.length : firstBreak);
    if (
      !doc.degraded &&
      (joinedLine > MAX_LINE_FOR_PREVIEW || length + text.length > MAX_DOC_FOR_PREVIEW || hasLongLine(text))
    ) {
      doc.degraded = true;
    }
    const spec = {
      changes: { from: length, insert: text },
      annotations: [Transaction.addToHistory.of(false), loadingText.of(true)],
      effects:
        doc.degraded && doc.mode === "formatted" ? [modeCompartment.reconfigure(modeExtensions.syntax)] : [],
    };
    if (doc.id === this.activeId && this.view) this.view.dispatch(spec);
    else doc.state = doc.state.update(spec).state;
  }

  resetDoc(tabId: string, text: string): void {
    const doc = this.docs.get(tabId);
    if (!doc) return;
    const wasDirty = doc.dirty;
    const fresh = this.newRecord(tabId, text, doc.mode);
    this.docs.set(tabId, fresh);
    if (tabId === this.activeId && this.view) this.view.setState(fresh.state);
    if (wasDirty) this.host?.onDirtyChange(tabId, false);
    if (tabId === this.activeId) this.notifyActivated(fresh);
  }

  dropDoc(tabId: string): void {
    if (tabId === this.activeId) {
      this.activeId = null;
      this.view?.setState(this.placeholderState());
    }
    this.docs.delete(tabId);
    this.sleeping.delete(tabId);
  }

  hasDoc(tabId: string): boolean {
    return this.docs.has(tabId);
  }

  /** Puts the active document away and shows the placeholder, e.g. while the next tab loads. */
  park(): void {
    const view = this.view;
    if (!view || !this.stashActive()) return;
    this.activeId = null;
    view.setState(this.placeholderState());
  }

  /** Stores the view's state back into the active record. False when nothing is active. */
  private stashActive(): boolean {
    const view = this.view;
    const previous = this.activeDoc();
    if (!view || !previous) return false;
    this.finder.clear();
    previous.state = view.state;
    previous.scrollEffect = view.scrollSnapshot();
    previous.scrollTop = view.scrollDOM.scrollTop;
    return true;
  }

  activate(tabId: string): void {
    const doc = this.docs.get(tabId);
    const view = this.view;
    if (!doc || !view || tabId === this.activeId) return;
    if (!this.stashActive()) this.finder.clear();
    clearTimeout(this.recheckTimer);
    this.recheckTimer = 0;
    this.activeId = tabId;
    doc.state = this.withConfig(doc.state, doc);
    view.setState(doc.state);
    if (doc.scrollEffect) {
      view.dispatch({ effects: doc.scrollEffect });
      doc.scrollEffect = null;
      doc.scrollTop = null;
    } else if (doc.scrollTop !== null) {
      this.applyScrollTop(doc.scrollTop);
      doc.scrollTop = null;
    }
    this.notifyActivated(doc);
    // A deletion just before the last tab switch may have removed the long line.
    if (doc.degraded && doc.mode === "formatted") this.scheduleRecheck(doc);
  }

  /** Callers may pass an oversized value (Ctrl+End sends 1e9), so it is clamped to the valid range. */
  private applyScrollTop(top: number): void {
    const view = this.view;
    view?.requestMeasure({
      read: () => Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight),
      write: (maxTop) => {
        view.scrollDOM.scrollTop = Math.min(Math.max(0, top), maxTop);
      },
    });
  }

  getText(tabId: string): string {
    const doc = this.docs.get(tabId);
    return doc ? this.stateOf(doc).doc.toString() : "";
  }

  firstLine(tabId: string): string {
    const doc = this.docs.get(tabId);
    return doc ? this.stateOf(doc).doc.line(1).text : "";
  }

  length(tabId: string): number {
    const doc = this.docs.get(tabId);
    return doc ? this.stateOf(doc).doc.length : 0;
  }

  markSaved(tabId: string): void {
    const doc = this.docs.get(tabId);
    if (!doc) return;
    // Closing the undo group keeps the next edit from joining the saved event.
    const spec = { annotations: isolateHistory.of("full") };
    if (doc.id === this.activeId && this.view) this.view.dispatch(spec);
    else doc.state = doc.state.update(spec).state;
    if (doc.versions[doc.depth] === undefined) doc.versions[doc.depth] = ++versionCounter;
    doc.savedVersion = doc.versions[doc.depth];
    this.refreshDirty(doc);
  }

  snapshot(tabId: string): ScrollSnapshot | null {
    const doc = this.docs.get(tabId);
    if (!doc) return null;
    const { anchor, head } = this.stateOf(doc).selection.main;
    const scrollTop =
      doc.id === this.activeId && this.view ? this.view.scrollDOM.scrollTop : (doc.scrollTop ?? 0);
    return { anchor, head, scrollTop };
  }

  restore(tabId: string, snap: ScrollSnapshot): void {
    const doc = this.docs.get(tabId);
    if (!doc) return;
    const length = this.stateOf(doc).doc.length;
    const selection = { anchor: Math.min(snap.anchor, length), head: Math.min(snap.head, length) };
    if (doc.id === this.activeId && this.view) {
      this.view.dispatch({ selection });
      this.applyScrollTop(snap.scrollTop);
    } else {
      doc.state = doc.state.update({ selection }).state;
      doc.scrollEffect = null;
      doc.scrollTop = snap.scrollTop;
    }
  }

  setMode(tabId: string, mode: FormatMode): void {
    const doc = this.docs.get(tabId);
    if (!doc || doc.mode === mode) return;
    doc.mode = mode;
    // Edits made in another mode are not checked for long lines (checkDegrade), so look again.
    if (mode === "formatted") doc.degraded = needsDegrade(this.stateOf(doc).doc);
    const effects = modeCompartment.reconfigure(modeExtensions[this.effectiveMode(doc)]);
    if (doc.id === this.activeId && this.view) {
      this.view.dispatch({ effects });
      this.lastContext = null;
      this.scheduleCursor();
    } else {
      doc.state = doc.state.update({ effects }).state;
    }
  }

  setConfig(partial: Partial<EditorConfig>): void {
    const previous = this.config;
    this.config = { ...previous, ...partial, zoom: clampZoom(partial.zoom ?? previous.zoom) };
    const { config } = this;
    const wrapChanged = config.wordWrap !== previous.wordWrap;
    const attributesChanged =
      config.spellcheck !== previous.spellcheck || config.autocorrect !== previous.autocorrect;
    if (wrapChanged || attributesChanged) {
      this.configSerial++;
      const active = this.activeDoc();
      if (active && this.view) {
        active.configSerial = this.configSerial;
        this.view.dispatch({
          effects: [
            wrapCompartment.reconfigure(this.wrapExtension()),
            attributesCompartment.reconfigure(this.attributesExtension()),
          ],
        });
      }
    }
    this.applyCssVariables();
  }

  // ---------- Editing ----------

  format(command: FormatCommand): void {
    if (this.view) applyFormat(this.view, command);
  }

  undo(): void {
    if (this.view) undo(this.view);
  }

  redo(): void {
    if (this.view) redo(this.view);
  }

  async cut(): Promise<void> {
    const view = this.view;
    const text = this.selectionText();
    if (!view || !text) return;
    const before = view.state;
    // The text is only removed once it is safely on the clipboard.
    await navigator.clipboard.writeText(text);
    // The write is async: cut what was copied, not whatever is selected by now.
    if (this.view === view && view.state === before) this.deleteSelection();
  }

  async copy(): Promise<void> {
    const text = this.selectionText();
    if (text) await navigator.clipboard.writeText(text);
  }

  async paste(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const tab = this.activeId;
    const { selection } = view.state;
    const text = await navigator.clipboard.readText();
    // The read is async (and may wait on a permission prompt): paste where it was asked for,
    // never into a tab switched to meanwhile or at a cursor moved since (BUGS.md EDIT-10).
    if (!text || this.view !== view || this.activeId !== tab || !view.state.selection.eq(selection)) return;
    this.insertText(text);
  }

  deleteSelection(): void {
    this.view?.dispatch(this.view.state.replaceSelection(""), { userEvent: "delete.selection", scrollIntoView: true });
  }

  selectAll(): void {
    if (!this.view) return;
    // In a table cell, Select All selects the cell's text, as in any text box (BUGS.md M1).
    if (focusedTable(this.view)?.selectActiveCell()) return;
    selectAll(this.view);
  }

  insertText(text: string): void {
    const view = this.view;
    if (!view) return;
    // Text for a table cell (Paste, F5, a link) must not break the row with a newline or pipe.
    // Decided per cursor: with several, only those in a table get escaped text (BUGS.md EDIT-11).
    const spec = view.state.changeByRange((range) => {
      const table = tableAt(view, range.from);
      const insert = table && table === tableAt(view, range.to) ? escapeCellText(text) : text;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    });
    view.dispatch(spec, { userEvent: "input", scrollIntoView: true });
  }

  selectionText(): string {
    const view = this.view;
    if (!view) return "";
    const { state } = view;
    return state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => state.sliceDoc(range.from, range.to))
      .join(state.lineBreak);
  }

  goToLine(line: number): void {
    const view = this.view;
    if (!view) return;
    const { doc } = view.state;
    const target = doc.line(Math.min(doc.lines, Math.max(1, Math.floor(line))));
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
  }

  lineCount(): number {
    return this.view ? this.view.state.doc.lines : 0;
  }

  focus(): void {
    this.view?.focus();
  }

  // ---------- Find ----------

  find(query: FindQuery): FindResult {
    return this.finder.find(query);
  }

  findNext(): FindResult {
    return this.finder.next();
  }

  findPrev(): FindResult {
    return this.finder.prev();
  }

  replaceCurrent(): FindResult {
    return this.finder.replaceCurrent();
  }

  replaceAll(): number {
    return this.finder.replaceAll();
  }

  clearFind(): void {
    this.finder.clear();
  }

  onFindResult(listener: ((result: FindResult) => void) | null): void {
    this.finder.setListener(listener);
  }
}

export const engine: EditorEngine = new Engine();
