// An in-memory stand-in for the Rust side, at the IPC boundary only. It follows the
// contract in src/lib/ipc.ts and the behaviour of src-tauri/src/files.rs and
// store.rs closely enough for the frontend's loading, saving and change detection
// to be exercised for real: byte offsets, chunk cuts (last LF, or a CR that is not
// the window's last byte, else a UTF-8 character boundary), CRLF/LF/CR, the UTF-8
// BOM, tail saves, STALE rejections, missing folders and draft id validation.
//
// Known differences from Rust, none of which the frontend tests rely on:
// - Only UTF-8 (with or without BOM) is modelled. Rust also detects UTF-16 BOMs
//   and falls back to the ANSI code page for invalid UTF-8; the fake decodes
//   invalid bytes as U+FFFD.
// - Writes are not atomic and there is no ReplaceFileW / in-place fallback.
// - Error strings for missing files and folders copy Windows' wording, but other
//   I/O errors only happen when a test injects them with `failNext`.

export interface FakeStamp {
  size: number;
  mtimeMs: number;
}

interface FakeFile {
  bytes: Uint8Array;
  mtimeMs: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const BOM = [0xef, 0xbb, 0xbf];

const key = (path: string) => path.replace(/\//g, "\\").toLowerCase();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** files.rs `first_eol`: a CR at the end of an incomplete window may be half a CRLF. */
function firstEol(bytes: Uint8Array, complete: boolean): "CRLF" | "LF" | "CR" | null {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) return "LF";
    if (bytes[i] === 13) {
      if (i + 1 < bytes.length) return bytes[i + 1] === 10 ? "CRLF" : "CR";
      return complete ? "CR" : "CRLF";
    }
  }
  return null;
}

/** files.rs `cut_bytes` + `utf8_char_cut`. */
function cutChunk(body: Uint8Array): number {
  const len = body.length;
  for (let i = len - 1; i >= 0; i--) {
    if (body[i] === 10 || (body[i] === 13 && i + 1 < len)) return i + 1;
  }
  if (body[len - 1] === 13) return len - 1;
  for (let back = 1; back <= Math.min(3, len); back++) {
    const byte = body[len - back];
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? len - back : len;
  }
  return len;
}

/** store.rs `draft_path`: one path component of [A-Za-z0-9_-], never a device name. */
function validDraftId(id: string): boolean {
  const upper = id.toUpperCase();
  const device =
    ["CON", "PRN", "AUX", "NUL"].includes(upper) || /^(COM|LPT)\d$/.test(upper);
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id) && !device;
}

const parentKey = (path: string) => {
  const k = key(path);
  const cut = k.lastIndexOf("\\");
  return cut > 0 ? k.slice(0, cut) : null;
};

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

export class FakeBackend {
  files = new Map<string, FakeFile>();
  /** Folders that exist. Writing a file creates its folders; saving does not. */
  dirs = new Set<string>();
  session: string | null = null;
  /** Per-window sessions (store.rs `window_session_*`), by key. */
  windowSessions = new Map<string, string>();
  drafts = new Map<string, string>();
  pendingPaths: string[] = [];
  /** What `take_window_boot` hands the next window that boots; drained once. */
  boot: { restore: string | null; transfer: string | null } = { restore: null, transfer: null };
  /** Answer of `tab_drop_target`: the other window under the mouse. */
  dropTarget: { label: string; x: number; y: number } | null = null;
  /** Every command name, in order. */
  calls: { cmd: string; args: Record<string, unknown> }[] = [];
  /** Next error for a command, by name; consumed once. */
  failNext = new Map<string, string>();
  /** Paths whose reads always fail (a locked file). */
  unreadable = new Set<string>();
  isLastWindow = true;
  private clock = 1_000;

  reset(): void {
    this.files.clear();
    this.dirs.clear();
    this.session = null;
    this.windowSessions.clear();
    this.drafts.clear();
    this.pendingPaths = [];
    this.boot = { restore: null, transfer: null };
    this.dropTarget = null;
    this.calls = [];
    this.failNext.clear();
    this.unreadable.clear();
    this.isLastWindow = true;
  }

  /** Writes a file "from another program". Strings are stored as UTF-8. */
  write(path: string, content: string | Uint8Array): void {
    const bytes = typeof content === "string" ? encoder.encode(content) : content;
    this.mkdir(parentKey(path) ?? "");
    this.files.set(key(path), { bytes, mtimeMs: (this.clock += 1000) });
  }

  /** Creates a folder and its parents, like `mkdir -p`. */
  mkdir(path: string): void {
    for (let k: string | null = key(path); k; k = parentKey(k)) this.dirs.add(k);
  }

  delete(path: string): void {
    this.files.delete(key(path));
  }

  exists(path: string): boolean {
    return this.files.has(key(path));
  }

  bytes(path: string): Uint8Array {
    const file = this.files.get(key(path));
    if (!file) throw new Error(`no such file: ${path}`);
    return file.bytes;
  }

  /** The file decoded as UTF-8 with its line endings and BOM kept. */
  text(path: string): string {
    return decoder.decode(this.bytes(path));
  }

  count(cmd: string): number {
    return this.calls.filter((c) => c.cmd === cmd).length;
  }

  private stampOf(path: string): FakeStamp | null {
    const file = this.files.get(key(path));
    return file ? { size: file.bytes.length, mtimeMs: file.mtimeMs } : null;
  }

  async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ cmd, args });
    // Let other promise chains run first, as a real IPC round trip would.
    await Promise.resolve();
    const failure = this.failNext.get(cmd);
    if (failure !== undefined) {
      this.failNext.delete(cmd);
      throw failure;
    }
    switch (cmd) {
      case "file_read_chunk":
        return this.readChunk(args.path as string, args.offset as number, args.maxBytes as number);
      case "file_stat":
        return this.stampOf(args.path as string);
      case "file_save":
        return this.save(args.req as SaveArgs);
      case "file_scan": {
        const text = normalize(decoder.decode(this.stripBom(this.bytes(args.path as string))));
        return { chars: text.length, lines: text.split("\n").length };
      }
      case "session_read":
        return this.session;
      case "session_write":
        this.session = args.json as string;
        return null;
      case "window_sessions_read":
        return [...this.windowSessions].sort().map(([key, json]) => ({ key, json }));
      case "window_session_write":
      case "window_session_delete": {
        const key = args.key as string;
        if (!validDraftId(key)) throw `invalid session key: ${JSON.stringify(key)}`;
        if (cmd === "window_session_write") this.windowSessions.set(key, args.json as string);
        else this.windowSessions.delete(key);
        return null;
      }
      case "take_window_boot": {
        const boot = this.boot;
        this.boot = { restore: null, transfer: null };
        return boot;
      }
      case "tab_drop_target":
        return this.dropTarget;
      case "draft_read":
      case "draft_write":
      case "draft_delete": {
        const id = args.id as string;
        if (!validDraftId(id)) throw `invalid draft id: ${JSON.stringify(id)}`;
        if (cmd === "draft_read") return this.drafts.get(id) ?? null;
        if (cmd === "draft_write") this.drafts.set(id, args.text as string);
        else this.drafts.delete(id);
        return null;
      }
      case "take_pending_paths": {
        const paths = this.pendingPaths;
        this.pendingPaths = [];
        return paths;
      }
      case "is_last_window":
        return this.isLastWindow;
      case "system_fonts":
        return ["Arial", "Inter", "Segoe UI"];
      case "update_configure":
      case "update_status":
        return { phase: "idle", version: null, message: null, current: "0.1.0", canInstall: false };
      case "launched_hidden":
        return false;
      case "window_new":
      case "reveal_in_explorer":
      case "enter_background":
        return null;
      default:
        throw new Error(`fake backend: unknown command ${cmd}`);
    }
  }

  private stripBom(bytes: Uint8Array): Uint8Array {
    return bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2] ? bytes.subarray(3) : bytes;
  }

  private readChunk(path: string, offset: number, maxBytes: number) {
    if (this.unreadable.has(key(path))) throw "The process cannot access the file because it is being used by another process. (os error 32)";
    const file = this.files.get(key(path));
    if (!file) throw "The system cannot find the file specified. (os error 2)";
    const all = file.bytes;
    const size = all.length;
    const start = Math.min(offset, size);
    const want = Math.min(Math.max(maxBytes, 8), size - start);
    const window = all.subarray(start, start + want);
    const eof = start + window.length >= size;
    const bom = start === 0 && this.stripBom(window) !== window ? 3 : 0;
    const body = window.subarray(bom);
    const cut = eof ? body.length : cutChunk(body);
    // The first chunk detects the line ending from its own window; later chunks
    // repeat what the first 256 KiB of the file says (files.rs `known_format`).
    const eol =
      start === 0
        ? firstEol(body, eof)
        : firstEol(this.stripBom(all.subarray(0, 256 * 1024)), size <= 256 * 1024);
    return {
      text: normalize(decoder.decode(body.subarray(0, cut))),
      nextOffset: start + bom + cut,
      eof,
      encoding: this.stripBom(all) !== all ? "utf-8-bom" : "utf-8",
      eol: eol ?? "CRLF",
      stamp: { size, mtimeMs: file.mtimeMs },
    };
  }

  private save(req: SaveArgs): FakeStamp {
    const existing = this.files.get(key(req.path));
    const stamp = this.stampOf(req.path);
    if (req.expectedStamp && (stamp === null || stamp.size !== req.expectedStamp.size || stamp.mtimeMs !== req.expectedStamp.mtimeMs)) {
      throw "STALE";
    }
    const eol = req.eol === "CRLF" ? "\r\n" : req.eol === "CR" ? "\r" : "\n";
    const body = encoder.encode(normalize(req.text).replace(/\n/g, eol));
    const parts: Uint8Array[] = [req.encoding === "utf-8-bom" ? new Uint8Array(BOM) : new Uint8Array(), body];
    const parent = parentKey(req.path);
    if (parent && !this.dirs.has(parent)) throw "The system cannot find the path specified. (os error 3)";
    if (req.tailOffset !== null) {
      // files.rs `append_tail`: a missing source is an I/O error, a short one is STALE.
      if (!existing) throw "The system cannot find the file specified. (os error 2)";
      if (req.tailOffset > existing.bytes.length) throw "STALE";
      parts.push(existing.bytes.subarray(req.tailOffset));
    }
    this.files.set(key(req.path), { bytes: concat(...parts), mtimeMs: (this.clock += 1000) });
    return this.stampOf(req.path) as FakeStamp;
  }
}

interface SaveArgs {
  path: string;
  text: string;
  eol: "CRLF" | "LF" | "CR";
  encoding: string;
  tailOffset: number | null;
  expectedStamp: FakeStamp | null;
}

/** The current window, as far as actions.ts uses it. */
export class FakeWindow {
  label = "main";
  closeHandler: ((event: { preventDefault: () => void }) => Promise<void> | void) | null = null;
  /** Outcome of each close request: true when the page allowed the window to close. */
  closes: boolean[] = [];
  destroyed = false;
  /** Event listeners of this window, by event name. */
  listeners = new Map<string, (event: { payload: unknown }) => void>();
  /** How many backend calls had been made when each listener was registered. */
  listenedAt = new Map<string, number>();
  /** Events this window sent: to "*" (every window) or to one window label. */
  emitted: { target: string; event: string; payload: unknown }[] = [];
  /** Times the window was brought to the front (unminimize + show + focus). */
  focused = 0;

  reset(label = "main"): void {
    this.label = label;
    this.closeHandler = null;
    this.closes = [];
    this.destroyed = false;
    this.listeners.clear();
    this.listenedAt.clear();
    this.emitted = [];
    this.focused = 0;
  }

  /** Delivers an event to this window, as Rust or another window would. */
  deliver(event: string, payload: unknown): void {
    const listener = this.listeners.get(event);
    if (!listener) throw new Error(`no listener for ${event}`);
    listener({ payload });
  }

  async close(): Promise<void> {
    let prevented = false;
    await this.closeHandler?.({ preventDefault: () => (prevented = true) });
    this.closes.push(!prevented);
  }
}

/** Answers for the native file dialogs, consumed in order. */
export class FakeDialogs {
  saveAnswers: (string | null)[] = [];
  openAnswers: (string[] | null)[] = [];
  saveRequests: { defaultPath?: string }[] = [];
  openedUrls: string[] = [];
  /** Answers for yes/no questions (`ask`), consumed in order; false when empty. */
  askAnswers: boolean[] = [];
  asked: string[] = [];

  reset(): void {
    this.saveAnswers = [];
    this.openAnswers = [];
    this.saveRequests = [];
    this.openedUrls = [];
    this.askAnswers = [];
    this.asked = [];
  }
}

// One instance of each per test worker. They live on globalThis so that the
// vi.mock factories and the test see the same objects even after vi.resetModules.
const shared = globalThis as unknown as {
  __fakeBackend?: FakeBackend;
  __fakeWindow?: FakeWindow;
  __fakeDialogs?: FakeDialogs;
};
export const backend = (shared.__fakeBackend ??= new FakeBackend());
export const fakeWindow = (shared.__fakeWindow ??= new FakeWindow());
export const dialogs = (shared.__fakeDialogs ??= new FakeDialogs());

/** Module factories for vi.mock, so each test file mocks Tauri the same way. */
export const tauriMocks = {
  core: () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => backend.invoke(cmd, args),
    convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  }),
  window: () => ({
    getCurrentWindow: () => ({
      get label() {
        return fakeWindow.label;
      },
      close: () => fakeWindow.close(),
      destroy: async () => {
        fakeWindow.destroyed = true;
      },
      setTheme: async () => {},
      unminimize: async () => {},
      show: async () => {},
      setFocus: async () => {
        fakeWindow.focused++;
      },
      onCloseRequested: async (handler: FakeWindow["closeHandler"]) => {
        fakeWindow.closeHandler = handler;
        return () => {};
      },
      onFocusChanged: async () => () => {},
      isFocused: async () => false,
    }),
  }),
  webview: () => ({
    getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
  }),
  webviewWindow: () => ({
    getCurrentWebviewWindow: () => ({
      listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
        fakeWindow.listeners.set(event, handler);
        fakeWindow.listenedAt.set(event, backend.calls.length);
        return () => {};
      },
      emit: async (event: string, payload: unknown) => {
        fakeWindow.emitted.push({ target: "*", event, payload });
      },
      emitTo: async (target: string, event: string, payload: unknown) => {
        fakeWindow.emitted.push({ target, event, payload });
      },
    }),
    getAllWebviewWindows: async () => [],
  }),
  dialog: () => ({
    save: async (options: { defaultPath?: string }) => {
      dialogs.saveRequests.push(options);
      return dialogs.saveAnswers.shift() ?? null;
    },
    open: async () => dialogs.openAnswers.shift() ?? null,
    ask: async (message: string) => {
      dialogs.asked.push(message);
      return dialogs.askAnswers.shift() ?? false;
    },
  }),
  opener: () => ({
    openUrl: async (url: string) => {
      dialogs.openedUrls.push(url);
    },
  }),
};
