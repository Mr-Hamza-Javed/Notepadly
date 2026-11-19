// An in-memory stand-in for the Rust side, at the IPC boundary only. It follows the
// contract in src/lib/ipc.ts and the behaviour of src-tauri/src/files.rs and
// store.rs closely enough for the frontend's loading, saving and change detection
// to be exercised for real: byte offsets, chunk cuts (last LF, or a CR that is not
// the window's last byte, else a UTF-8 character boundary), CRLF/LF/CR, the UTF-8
// BOM, tail saves, STALE rejections, missing folders and draft id validation.
//
// Known differences from Rust, none of which the frontend tests rely on:
// - UTF-8 (with or without BOM) and ANSI are modelled; ANSI is always
//   windows-1252. Like Rust, the first 256 KiB decide between UTF-8 and ANSI,
//   and an encoding passed at offset 0 forces it. UTF-16 is not modelled.
// - Writes are not atomic and there is no ReplaceFileW / in-place fallback.
// - Mixed line endings are not kept on save (files.rs `kept_line_endings`):
//   every line gets the requested ending, as with `normalizeEol`.
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
const strictDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const ansiDecoder = new TextDecoder("windows-1252");
const BOM = [0xef, 0xbb, 0xbf];

const isUtf8 = (bytes: Uint8Array) => {
  try {
    strictDecoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** windows-1252 for the fake's ANSI, built from the decoder. */
const ansiBytes = new Map<string, number>(
  Array.from({ length: 256 }, (_, b) => [ansiDecoder.decode(new Uint8Array([b])), b] as [string, number]),
);

/** files.rs `encode_ansi`: the first unmappable character fails the save unless lossy. */
function encodeAnsi(text: string, lossy: boolean): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const byte = ansiBytes.get(ch);
    if (byte !== undefined) out.push(byte);
    else if (lossy) out.push(0x3f);
    else throw `UNMAPPABLE: ${ch}`;
  }
  return new Uint8Array(out);
}

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
function cutChunk(body: Uint8Array, singleByte = false): number {
  const len = body.length;
  for (let i = len - 1; i >= 0; i--) {
    if (body[i] === 10 || (body[i] === 13 && i + 1 < len)) return i + 1;
  }
  if (body[len - 1] === 13) return len - 1;
  if (singleByte) return len;
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
  drafts = new Map<string, string>();
  pendingPaths: string[] = [];
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
    this.drafts.clear();
    this.pendingPaths = [];
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
        return this.readChunk(
          args.path as string,
          args.offset as number,
          args.maxBytes as number,
          (args.encoding as string | null | undefined) ?? null,
        );
      case "file_stat":
        return this.stampOf(args.path as string);
      case "file_save":
        return this.save(args.req as SaveArgs);
      case "file_scan": {
        const raw = this.stripBom(this.bytes(args.path as string));
        const ansi = args.encoding === "ansi";
        const text = normalize((ansi ? ansiDecoder : decoder).decode(raw));
        return { chars: text.length, lines: text.split("\n").length, invalid: !ansi && !isUtf8(raw) };
      }
      case "session_read":
        return this.session;
      case "session_write":
        this.session = args.json as string;
        return null;
      case "drafts_prune": {
        const keep = args.keep as string[];
        for (const id of [...this.drafts.keys()]) if (!keep.includes(id)) this.drafts.delete(id);
        return null;
      }
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

  /** files.rs `detect_encoding` over the first 256 KiB (a cut-off sequence at the end is fine). */
  private detect(all: Uint8Array): string {
    if (this.stripBom(all) !== all) return "utf-8-bom";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(all.subarray(0, 256 * 1024), {
        stream: all.length > 256 * 1024,
      });
      return "utf-8";
    } catch {
      return "ansi";
    }
  }

  private readChunk(path: string, offset: number, maxBytes: number, hint: string | null) {
    if (this.unreadable.has(key(path))) throw "The process cannot access the file because it is being used by another process. (os error 32)";
    const file = this.files.get(key(path));
    if (!file) throw "The system cannot find the file specified. (os error 2)";
    const all = file.bytes;
    const size = all.length;
    const start = Math.min(offset, size);
    const want = Math.min(Math.max(maxBytes, 8), size - start);
    const window = all.subarray(start, start + want);
    const eof = start + window.length >= size;
    const encoding = hint ?? this.detect(all);
    const bom = start === 0 && encoding !== "ansi" && this.stripBom(window) !== window ? 3 : 0;
    const body = window.subarray(bom);
    const ansi = encoding === "ansi";
    const cut = eof ? body.length : cutChunk(body, ansi);
    // The first chunk detects the line ending from its own window; later chunks
    // repeat what the first 256 KiB of the file says (files.rs `known_format`).
    const eol =
      start === 0
        ? firstEol(body, eof)
        : firstEol(this.stripBom(all.subarray(0, 256 * 1024)), size <= 256 * 1024);
    return {
      text: normalize((ansi ? ansiDecoder : decoder).decode(body.subarray(0, cut))),
      nextOffset: start + bom + cut,
      eof,
      encoding: encoding === "utf-8" && bom ? "utf-8-bom" : encoding,
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
    const final = normalize(req.text).replace(/\n/g, eol);
    const body = req.encoding === "ansi" ? encodeAnsi(final, !!req.allowLossy) : encoder.encode(final);
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
  allowLossy?: boolean;
  normalizeEol?: boolean;
}

/** The current window, as far as actions.ts uses it. */
export class FakeWindow {
  label = "main";
  closeHandler: ((event: { preventDefault: () => void }) => Promise<void> | void) | null = null;
  /** Outcome of each close request: true when the page allowed the window to close. */
  closes: boolean[] = [];
  destroyed = false;

  reset(label = "main"): void {
    this.label = label;
    this.closeHandler = null;
    this.closes = [];
    this.destroyed = false;
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
  /** Button labels for the next native message boxes; an empty queue answers "Cancel". */
  messageAnswers: string[] = [];
  messages: { title?: string; body: string }[] = [];
  /** Files handed to the default app (`openPath`). */
  openedPaths: string[] = [];

  reset(): void {
    this.saveAnswers = [];
    this.openAnswers = [];
    this.saveRequests = [];
    this.openedUrls = [];
    this.messageAnswers = [];
    this.messages = [];
    this.openedPaths = [];
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
    getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
    getAllWebviewWindows: async () => [],
  }),
  dialog: () => ({
    save: async (options: { defaultPath?: string }) => {
      dialogs.saveRequests.push(options);
      return dialogs.saveAnswers.shift() ?? null;
    },
    open: async () => dialogs.openAnswers.shift() ?? null,
    message: async (body: string, options?: { title?: string }) => {
      dialogs.messages.push({ title: options?.title, body });
      return dialogs.messageAnswers.shift() ?? "Cancel";
    },
  }),
  opener: () => ({
    openUrl: async (url: string) => {
      dialogs.openedUrls.push(url);
    },
    openPath: async (path: string) => {
      dialogs.openedPaths.push(path);
    },
  }),
};
