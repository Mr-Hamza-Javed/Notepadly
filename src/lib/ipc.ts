// CONTRACT between the frontend and src-tauri. Rust commands must match these
// names and (camelCase) argument/field names exactly.
import { invoke } from "@tauri-apps/api/core";

export type Eol = "CRLF" | "LF" | "CR";
/**
 * "utf-16le"/"utf-16be" are written with a BOM, the "-nobom" forms without one
 * (FILES-2). "ansi" is the system ANSI code page, "oem" the DOS one (437, 850...).
 */
export type Encoding =
  | "utf-8"
  | "utf-8-bom"
  | "utf-16le"
  | "utf-16le-nobom"
  | "utf-16be"
  | "utf-16be-nobom"
  | "ansi"
  | "oem";

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
  /** The file has the read-only attribute, so saving it in place will fail. Only on the chunk at offset 0. */
  readOnly?: boolean;
  /** This chunk holds NUL characters: probably not a text file, and saving can damage it. */
  binary?: boolean;
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
  /** The encoding the file was read with, so Rust can read its old lines after an encoding change. */
  originalEncoding?: Encoding;
  /**
   * With `tailOffset`: the file the bytes after it are copied from, when not `path`.
   * Save As of a partly loaded file streams the rest of the old file (M13).
   */
  tailPath?: string;
  /** The stamp `tailPath` must still have, or the save fails with "STALE". */
  tailStamp?: FileStamp;
}

export interface FileScan {
  /** Characters in code points (an emoji is 1), after CRLF counts as one. */
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
  /**
   * The file's identity (volume serial and file index on Windows), equal for every
   * path that reaches the same file: 8.3 short names, mapped drive vs UNC, links.
   * Null when the file cannot be opened. A save can change it: compare fresh values only.
   */
  pathIdentity: (path: string) => invoke<string | null>("path_identity", { path }),

  sessionRead: () => invoke<string | null>("session_read"),
  sessionWrite: (json: string) => invoke<void>("session_write", { json }),
  draftRead: (id: string) => invoke<string | null>("draft_read", { id }),
  draftWrite: (id: string, text: string) => invoke<void>("draft_write", { id, text }),
  draftDelete: (id: string) => invoke<void>("draft_delete", { id }),
  /**
   * Deletes every draft whose id is not in `keep`. Rust spares drafts created
   * during this run, even if no stored session lists them yet (MERGE-1).
   */
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
  newWindow: (
    paths: string[],
    options: { restore?: string; transfer?: string; atCursor?: boolean; follow?: boolean } = {},
  ) => invoke<void>("window_new", { paths, ...options }),
  /** The other window under the mouse, for a tab dropped on it. */
  tabDropTarget: () => invoke<DropTarget | null>("tab_drop_target"),
  /**
   * This window follows the mouse until the button goes up (F2, its only tab dragged
   * out); `window-drag-end` then says it is over and `windowDragResult` how.
   */
  windowDragStart: () => invoke<void>("window_drag_start"),
  /** How this window's last drag ended, given once; null while it runs. */
  windowDragResult: () => invoke<WindowDragEnd | null>("window_drag_result"),
  systemFonts: () => invoke<string[]>("system_fonts"),
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),

  /** Replaces the list of paths this window has open, for path_open_elsewhere (WIN-3). */
  openPathsSet: (paths: string[]) => invoke<void>("open_paths_set", { paths }),
  /**
   * The label of another window that has `path` open, or null. Rust then focuses
   * that window and sends it OPEN_PATHS_HERE_EVENT with [path], so it shows the
   * tab: the file must not be opened here too (WIN-3).
   */
  pathOpenElsewhere: (path: string) => invoke<string | null>("path_open_elsewhere", { path }),
  /** The user's regional format, for example "en-GB"; "" when unknown (MD-2). */
  userLocale: () => invoke<string>("user_locale"),
  /** True when no other app window is on screen. */
  isLastWindow: () => invoke<boolean>("is_last_window"),
  /**
   * Marks this window as closing and answers, in one step, whether every other
   * window on screen is closing too (STATE-8). Two windows closed together can
   * then not both think another window stays.
   */
  windowClosing: () => invoke<boolean>("window_closing"),
  /** This window's close was cancelled or it went to the background: it counts as staying again. */
  windowCloseCancelled: () => invoke<void>("window_close_cancelled"),
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

/** How a window drag ended (Rust `window_drag::DragEnd`). */
export interface WindowDragEnd {
  /** The other window's tab strip it was dropped on, if any. */
  target: DropTarget | null;
  /** Escape: the tab goes back where it came from. */
  cancelled: boolean;
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
