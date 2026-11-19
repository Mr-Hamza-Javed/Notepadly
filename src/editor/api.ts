// CONTRACT for the CodeMirror engine. One EditorView; one EditorState per tab.
export type FormatMode = "formatted" | "syntax" | "plain";

export interface EditorConfig {
  wordWrap: boolean;
  /** Percent, 10..500. */
  zoom: number;
  fontFamily: string;
  fontWeight: number;
  fontSizePt: number;
  spellcheck: boolean;
  autocorrect: boolean;
}

export interface CursorInfo {
  line: number;
  col: number;
  /** Characters in the loaded document. */
  chars: number;
  /** Characters currently selected; 0 when none. */
  selected: number;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * A Formatted tab shown as Markdown syntax because a line is over 20,000 characters
   * or the document is over 20 MB. Clears when that is no longer so.
   */
  previewLimited?: boolean;
}

export type BlockKind = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "body";
export type ListKind = "bullet" | "number" | "task" | "none";

/** What the toolbar should highlight for the current selection. */
export interface FormatContext {
  block: BlockKind;
  list: ListKind;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  link: boolean;
  inTable: boolean;
}

export type FormatCommand =
  | { type: "block"; kind: BlockKind }
  | { type: "list"; kind: ListKind }
  | { type: "bold" | "italic" | "strike" | "clear" | "link" }
  | { type: "table-insert"; rows: number; cols: number }
  | { type: "table-edit"; op: "row-above" | "row-below" | "col-left" | "col-right" | "del-row" | "del-col" | "del-table" };

export interface FindQuery {
  search: string;
  replace: string;
  caseSensitive: boolean;
  wrap: boolean;
  /** Matches only whole words (Notepad's "Match whole word"). */
  wholeWord?: boolean;
  /** `search` is a regular expression; `replace` may use `$&`, `$1`… Otherwise both are literal. */
  regexp?: boolean;
}

export interface FindResult {
  total: number;
  /** 1-based index of the current match; 0 when none. */
  current: number;
  /**
   * The count is still running in the background (a big document): `total` is what was found
   * so far. The final result goes to the `onFindResult` listener.
   */
  pending?: boolean;
  /** The regular expression does not compile. */
  invalid?: boolean;
}

/**
 * Editor state that can be sent to another window with a moved tab (F2): the undo
 * history (null when too big) and the callouts whose fold state was flipped.
 */
export interface CarriedDocState {
  /** The undo history as JSON, against a document of `length` characters. */
  history: unknown;
  length: number;
  versions: (number | null)[];
  depth: number;
  savedVersion: number;
  folds: number[];
}

export interface EditorHost {
  /** User edit only; never fired for appendText or loading. */
  onDirtyChange(tabId: string, dirty: boolean): void;
  /** Fired on doc edits; debounce heavy work on the receiving side. */
  onDocChange(tabId: string): void;
  onCursor(tabId: string, info: CursorInfo): void;
  onFormatContext(tabId: string, ctx: FormatContext): void;
  /** The viewport is within ~2 screens of the loaded end of the document. */
  onNearEnd(tabId: string): void;
  /** Ctrl+wheel or similar requested a zoom delta in percent. */
  onZoomDelta(delta: number): void;
  openLink(href: string): void;
  /** Directory of the tab's file, for resolving relative image paths. */
  baseDir(tabId: string): string | null;
  /** False while more of the tab's file is still to be loaded; true when not given. */
  isFullyLoaded?(tabId: string): boolean;
}

export interface ScrollSnapshot {
  anchor: number;
  head: number;
  scrollTop: number;
  /** Line starts of callouts folded or unfolded against their marker; absent when none. */
  folds?: number[];
}

export interface EditorEngine {
  mount(parent: HTMLElement, host: EditorHost, config: EditorConfig): void;
  destroy(): void;

  createDoc(tabId: string, text: string, mode: FormatMode): void;
  /** Appends lazily loaded text: no undo entry, no dirty flag, keeps scroll. */
  appendText(tabId: string, text: string): void;
  /** Replaces all text and clears undo history; marks the tab clean. */
  resetDoc(tabId: string, text: string): void;
  dropDoc(tabId: string): void;
  /** Drops the text of a clean tab to save memory, but keeps its undo history. */
  hibernate(tabId: string): void;
  /**
   * Creates the document of a hibernated tab again. `text` must be the text it
   * had when it went to sleep, possibly with more of the file after it. Returns
   * false (and starts a fresh history) when the history could not be restored.
   */
  wakeDoc(tabId: string, text: string, mode: FormatMode): boolean;
  /** What a tab moving to another window takes: undo history (when not too big) and folds. */
  carryState?(tabId: string): CarriedDocState | null;
  /**
   * Creates the document of a tab moved from another window with its carried state.
   * `text` null: the tab moved while hibernated, so the state is kept for `wakeDoc`.
   * Returns true when the undo history was restored.
   */
  adoptDoc?(tabId: string, text: string | null, mode: FormatMode, carried: CarriedDocState): boolean;
  hasDoc(tabId: string): boolean;
  activate(tabId: string): void;
  /** Shows an empty, read-only placeholder instead of the active tab until the next activate. */
  park(): void;

  getText(tabId: string): string;
  /** Text of line 1, without materialising the document. */
  firstLine?(tabId: string): string;
  length(tabId: string): number;
  markSaved(tabId: string): void;
  /** The tab's file path changed (first save, Save As): relative images resolve again. */
  pathChanged(tabId: string): void;
  snapshot(tabId: string): ScrollSnapshot | null;
  restore(tabId: string, snap: ScrollSnapshot): void;

  setMode(tabId: string, mode: FormatMode): void;
  setConfig(partial: Partial<EditorConfig>): void;

  format(cmd: FormatCommand): void;
  undo(): void;
  redo(): void;
  /** Rejects, leaving the text in place, when the clipboard cannot be written. */
  cut(): Promise<void>;
  copy(): Promise<void>;
  /** Rejects when the clipboard cannot be read. */
  paste(): Promise<void>;
  deleteSelection(): void;
  selectAll(): void;
  insertText(text: string): void;
  selectionText(): string;
  goToLine(line: number): void;
  lineCount(): number;
  focus(): void;

  find(query: FindQuery): FindResult;
  findNext(): FindResult;
  findPrev(): FindResult;
  replaceCurrent(): FindResult;
  replaceAll(): number;
  clearFind(): void;
  /** Receives the result of a find whose count finished after `find` returned (BUGS.md M14). */
  onFindResult?(listener: ((result: FindResult) => void) | null): void;
}
