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
}

export interface FindResult {
  total: number;
  /** 1-based index of the current match; 0 when none. */
  current: number;
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
}

export interface ScrollSnapshot {
  anchor: number;
  head: number;
  scrollTop: number;
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
  hasDoc(tabId: string): boolean;
  activate(tabId: string): void;

  getText(tabId: string): string;
  /** Text of line 1, without materialising the document. */
  firstLine?(tabId: string): string;
  length(tabId: string): number;
  markSaved(tabId: string): void;
  snapshot(tabId: string): ScrollSnapshot | null;
  restore(tabId: string, snap: ScrollSnapshot): void;

  setMode(tabId: string, mode: FormatMode): void;
  setConfig(partial: Partial<EditorConfig>): void;

  format(cmd: FormatCommand): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
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
}
