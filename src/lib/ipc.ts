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
}

export interface FileScan {
  chars: number;
  lines: number;
}

export const ipc = {
  /**
   * Opens, reads up to maxBytes from offset, closes. Never holds a handle
   * between calls and always opens with full share access (no file lock).
   * Pass encoding from the first chunk on later reads; offset 0 auto-detects.
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

  /** Paths from argv for this window; drained on first call. */
  takePendingPaths: () => invoke<string[]>("take_pending_paths"),
  newWindow: (paths: string[]) => invoke<void>("window_new", { paths }),
  systemFonts: () => invoke<string[]>("system_fonts"),
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),
};

/** Event carrying string[] of paths when a second launch forwards its argv. */
export const OPEN_PATHS_EVENT = "open-paths";
