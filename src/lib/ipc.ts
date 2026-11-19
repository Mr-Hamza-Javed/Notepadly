// CONTRACT between the frontend and src-tauri. Rust commands must match these
// names and (camelCase) argument/field names exactly.
import { invoke } from "@tauri-apps/api/core";

export type Eol = "CRLF" | "LF" | "CR";
export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "ansi";

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export interface FileChunk {
  /** Decoded text, line endings normalised to \n. */
  text: string;
  /** Byte offset to pass to the next read. */
  nextOffset: number;
  eof: boolean;
  encoding: Encoding;
  /** Detected from the first chunk; later chunks repeat the known value. */
  eol: Eol;
  stamp: FileStamp;
  /**
   * This chunk's text has a line ending other than `eol` (FILES-1). Optional:
   * a backend that does not report it is taken as "not mixed".
   */
  mixedEol?: boolean;
  /** The file has the read-only attribute, so saving it in place will fail. Optional. */
  readOnly?: boolean;
}

export interface SaveRequest {
  path: string;
  /** Text with \n line endings; Rust converts to `eol` and encodes. */
  text: string;
  eol: Eol;
  encoding: Encoding;
  /**
   * Non-null when the file is only partly loaded: Rust writes `text`, then
   * streams the original bytes from this offset onward. The rest of the file
   * never enters memory.
   */
  tailOffset: number | null;
  /** If set and the file on disk differs, Rust rejects with "STALE". */
  expectedStamp: FileStamp | null;
  /**
   * Lets characters the ANSI code page lacks become `?`. Otherwise such a save
   * fails with "UNMAPPABLE: <first character>" and writes nothing.
   */
  allowLossy?: boolean;
  /**
   * Writes every line ending as `eol`. Otherwise, for a file with mixed line
   * endings, the lines the save leaves unchanged keep their own.
   */
  normalizeEol?: boolean;
}

export interface FileScan {
  chars: number;
  lines: number;
  /** Some bytes are not valid in the encoding scanned with (they show as U+FFFD). */
  invalid: boolean;
}

export const ipc = {
  /**
   * Opens, reads up to maxBytes from offset, closes. Never holds a handle
   * between calls and always opens with full share access (no file lock).
   * Pass encoding from the first chunk on later reads. At offset 0, null
   * auto-detects and an encoding forces it (reopening with an encoding).
   */
  readChunk: (path: string, offset: number, maxBytes: number, encoding: Encoding | null) =>
    invoke<FileChunk>("file_read_chunk", { path, offset, maxBytes, encoding }),
  /** Null when the file no longer exists. */
  stat: (path: string) => invoke<FileStamp | null>("file_stat", { path }),
  save: (req: SaveRequest) => invoke<FileStamp>("file_save", { req }),
  /** Streams the file on a background thread with constant memory. */
  scan: (path: string, encoding: Encoding) => invoke<FileScan>("file_scan", { path, encoding }),

  sessionRead: () => invoke<string | null>("session_read"),
  sessionWrite: (json: string) => invoke<void>("session_write", { json }),
  draftRead: (id: string) => invoke<string | null>("draft_read", { id }),
  draftWrite: (id: string, text: string) => invoke<void>("draft_write", { id, text }),
  draftDelete: (id: string) => invoke<void>("draft_delete", { id }),
  /** Deletes every draft whose id is not in `keep`. */
  draftsPrune: (keep: string[]) => invoke<void>("drafts_prune", { keep }),

  /** Every window's stored session (one per window, see loader.setSessionKey). */
  windowSessionsRead: () => invoke<WindowSession[]>("window_sessions_read"),
  windowSessionWrite: (key: string, json: string) => invoke<void>("window_session_write", { key, json }),
  windowSessionDelete: (key: string) => invoke<void>("window_session_delete", { key }),

  /** Paths from argv for this window; drained on first call. */
  takePendingPaths: () => invoke<string[]>("take_pending_paths"),
  /** What this window was opened for besides paths; drained on first call. */
  takeWindowBoot: () => invoke<WindowBoot>("take_window_boot"),
  /**
   * Opens a window next to this one. `restore` makes it take over a stored window
   * session; `transfer` hands it a tab dragged out of this window (a JSON
   * TabTransfer), placed under the mouse when `atCursor` is set.
   */
  newWindow: (paths: string[], options: { restore?: string; transfer?: string; atCursor?: boolean } = {}) =>
    invoke<void>("window_new", { paths, ...options }),
  /** The other window under the mouse, for a tab dropped on it. */
  tabDropTarget: () => invoke<DropTarget | null>("tab_drop_target"),
  systemFonts: () => invoke<string[]>("system_fonts"),
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),

  /** True when no other app window is on screen. */
  isLastWindow: () => invoke<boolean>("is_last_window"),
  /** Hides this window and suspends its webview; the next launch wakes it. */
  enterBackground: () => invoke<void>("enter_background"),

  /** Turns the automatic update checks on or off. */
  updateConfigure: (enabled: boolean) => invoke<UpdateStatus>("update_configure", { enabled }),
  updateStatus: () => invoke<UpdateStatus>("update_status"),
  /** Checks GitHub now and downloads a newer version in the background. */
  updateCheckNow: () => invoke<UpdateStatus>("update_check_now"),
  /** True when this launch is the hidden restart after a background update. */
  launchedHidden: () => invoke<boolean>("launched_hidden"),
};

export interface WindowSession {
  key: string;
  json: string;
}

export interface WindowBoot {
  restore: string | null;
  transfer: string | null;
}

export interface DropTarget {
  label: string;
  /** Mouse position inside that window, in its CSS pixels. */
  x: number;
  y: number;
}

export type UpdatePhase = "idle" | "checking" | "upToDate" | "downloading" | "ready" | "available" | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  /** The new version this status is about, if any. */
  version: string | null;
  message: string | null;
  /** The running version. */
  current: string;
  /** False for the portable exe, which cannot install updates itself. */
  canInstall: boolean;
}

/** Event carrying string[] of paths when a second launch forwards its argv. */
export const OPEN_PATHS_EVENT = "open-paths";
/** Same, for the window that was waiting in the background: open them in a tab. */
export const OPEN_PATHS_HERE_EVENT = "open-paths-here";
