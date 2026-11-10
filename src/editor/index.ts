// CodeMirror engine: one EditorView, one EditorState per tab.
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  redo,
  redoDepth,
  selectAll,
  undo,
  undoDepth,
} from "@codemirror/commands";
import {
  Annotation,
  Compartment,
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
import { previewContext } from "./livePreview/context";
import { inlinePreview } from "./livePreview/inline";
import { markdownSupport, parseAhead } from "./markdown";
import { editorRootClass, lineDirections, tokenClasses, watchTheme } from "./theme";
import "./editor.css";

export { FIND_COUNT_LIMIT };

const MAX_LINE_FOR_PREVIEW = 20000;
const MAX_DOC_FOR_PREVIEW = 20 * 1024 * 1024;
const NEAR_END_THROTTLE_MS = 120;
/** History trims old events beyond this, which would misalign the depth-indexed versions. */
const HISTORY_DEPTH = 400;

const loadingText = Annotation.define<boolean>();

const modeCompartment = new Compartment();
const wrapCompartment = new Compartment();
const attributesCompartment = new Compartment();

const modeClass = (name: string) => EditorView.editorAttributes.of({ class: `cm-mode-${name}` });

const modeExtensions: Record<FormatMode, Extension> = {
  formatted: [modeClass("formatted"), markdownSupport, parseAhead, tokenClasses, blockPreview, inlinePreview],
  syntax: [modeClass("syntax"), markdownSupport, parseAhead, tokenClasses],
  plain: [modeClass("plain")],
};

interface DocRecord {
  id: string;
  /** Stale while the tab is active: use `stateOf`. */
  state: EditorState;
  mode: FormatMode;
  /** Sticky until the text is replaced: the document is too large for live preview. */
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

let versionCounter = 0;

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
  private activeId: string | null = null;
  private readonly finder = new FindController(() => this.view);

  private cursorFrame = 0;
  private lastContext: FormatContext | null = null;
  private lastNearEnd = 0;
  private nearEndTimer = 0;
  private disposers: (() => void)[] = [];

  // ---------- Lifecycle ----------

  mount(parent: HTMLElement, host: EditorHost, config: EditorConfig): void {
    this.destroy();
    this.host = host;
    this.config = { ...config, zoom: clampZoom(config.zoom) };
    this.configSerial++;
    previewContext.baseDir = () => (this.activeId ? host.baseDir(this.activeId) : null);
    previewContext.openLink = (href) => host.openLink(href);

    const view = new EditorView({ parent, state: this.createState("", "plain") });
    this.view = view;
    this.applyCssVariables();

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (event.deltaY !== 0) host.onZoomDelta(event.deltaY < 0 ? 10 : -10);
    };
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
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.view?.destroy();
    this.view = null;
    this.host = null;
    this.activeId = null;
    this.docs.clear();
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
      keymap.of([...historyKeymap, ...defaultKeymap.filter((binding) => binding.key !== "Mod-i")]),
    ];
  }

  private createState(text: string, mode: FormatMode): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
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
      ],
    });
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
    if (depth >= HISTORY_DEPTH) {
      // Old events may have been trimmed, so depths no longer identify versions.
      // The saved point becomes unreachable, which errs on the side of staying dirty.
      doc.versions = [];
      doc.savedVersion = -1;
    } else {
      doc.versions.length = Math.min(doc.versions.length, depth + 1);
    }
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
    if (doc.degraded || doc.mode !== "formatted") return;
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
    this.docs.set(tabId, this.newRecord(tabId, text, mode));
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
      this.view?.setState(this.createState("", "plain"));
    }
    this.docs.delete(tabId);
  }

  hasDoc(tabId: string): boolean {
    return this.docs.has(tabId);
  }

  activate(tabId: string): void {
    const doc = this.docs.get(tabId);
    const view = this.view;
    if (!doc || !view || tabId === this.activeId) return;
    const previous = this.activeDoc();
    if (previous) {
      previous.state = view.state;
      previous.scrollEffect = view.scrollSnapshot();
      previous.scrollTop = view.scrollDOM.scrollTop;
    }
    this.finder.clear();
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

  cut(): void {
    const text = this.selectionText();
    if (!text) return;
    void navigator.clipboard.writeText(text);
    this.deleteSelection();
  }

  copy(): void {
    const text = this.selectionText();
    if (text) void navigator.clipboard.writeText(text);
  }

  paste(): void {
    void navigator.clipboard.readText().then((text) => {
      if (text) this.insertText(text);
    });
  }

  deleteSelection(): void {
    this.view?.dispatch(this.view.state.replaceSelection(""), { userEvent: "delete.selection", scrollIntoView: true });
  }

  selectAll(): void {
    if (this.view) selectAll(this.view);
  }

  insertText(text: string): void {
    this.view?.dispatch(this.view.state.replaceSelection(text), { userEvent: "input", scrollIntoView: true });
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
}

export const engine: EditorEngine = new Engine();
