// CONTRACT for app state. Store lives in store.ts, behaviour in actions.ts.
import type { Encoding, Eol, FileStamp } from "../lib/ipc";
import type { CursorInfo, FormatContext, FormatMode } from "../editor/api";

export type ThemeSetting = "light" | "dark" | "system";

export interface Settings {
  theme: ThemeSetting;
  fontFamily: string;
  /** "Light" | "Regular" | "Medium" | "Semibold" | "Bold" */
  fontStyle: string;
  fontSizePt: number;
  wordWrap: boolean;
  /** Default for new tabs and markdown files. */
  formatting: boolean;
  openFilesIn: "tab" | "window";
  startup: "continue" | "new";
  recentFiles: boolean;
  spellcheck: boolean;
  autocorrect: boolean;
  statusBar: boolean;
  zoom: number;
}

export interface TabMeta {
  id: string;
  path: string | null;
  /** File name, or for untitled tabs the first line of text, or "Untitled". */
  title: string;
  dirty: boolean;
  mode: FormatMode;
  eol: Eol;
  encoding: Encoding;
  stamp: FileStamp | null;
  /** Bytes consumed so far. Equals file size once fully loaded. */
  loadedOffset: number;
  fullyLoaded: boolean;
  /** Total characters of the whole file, once the background scan finishes. */
  totalChars: number | null;
  externalChange: "modified" | "deleted" | null;
  /** Clean tab whose editor state was dropped to save memory. */
  hibernated: boolean;
}

export type Dialog =
  | { kind: "confirm-close"; tabId: string; resolve: (r: "save" | "discard" | "cancel") => void }
  | { kind: "goto"; }
  | { kind: "link"; initialText: string; initialUrl: string }
  | { kind: "page-setup" }
  | { kind: "message"; title: string; body: string };

export interface PageSetup {
  orientation: "portrait" | "landscape";
  marginMm: number;
  header: string;
  footer: string;
}

export interface AppState {
  tabs: TabMeta[];
  activeId: string;
  view: "editor" | "settings" | "help";
  settings: Settings;
  recent: string[];
  cursor: CursorInfo;
  format: FormatContext;
  find: { open: boolean; replace: boolean };
  dialog: Dialog | null;
  pageSetup: PageSetup;
  /** Resolved theme after applying "system". */
  dark: boolean;
}
