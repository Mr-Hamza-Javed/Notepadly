// An in-memory stand-in for the Rust side, at the IPC boundary only. It follows the
// contract in src/lib/ipc.ts and the behaviour of src-tauri/src/files.rs closely
// enough for the frontend's loading, saving and change detection to be exercised
// for real: byte offsets, chunk cuts on line boundaries, CRLF, BOM, tail saves and
// STALE rejections.

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

function firstEol(bytes: Uint8Array): "CRLF" | "LF" | "CR" | null {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10) return "LF";
    if (bytes[i] === 13) return bytes[i + 1] === 10 ? "CRLF" : "CR";
  }
  return null;
}

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

export class FakeBackend {
  files = new Map<string, FakeFile>();
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
    this.files.set(key(path), { bytes, mtimeMs: (this.clock += 1000) });
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
      case "draft_read":
        return this.drafts.get(args.id as string) ?? null;
      case "draft_write":
        this.drafts.set(args.id as string, args.text as string);
        return null;
      case "draft_delete":
        this.drafts.delete(args.id as string);
        return null;
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
    let cut = body.length;
    if (!eof) {
      const lastLf = body.lastIndexOf(10);
      if (lastLf >= 0) cut = lastLf + 1;
      else {
        // No line break: back off to a character boundary.
        while (cut > 0 && (body[cut - 1] & 0xc0) === 0x80) cut--;
        if (cut > 0 && body[cut - 1] >= 0xc0) cut--;
      }
    }
    return {
      text: normalize(decoder.decode(body.subarray(0, cut))),
      nextOffset: start + bom + cut,
      eof: eof && cut === body.length,
      encoding: bom ? "utf-8-bom" : "utf-8",
      eol: firstEol(this.stripBom(all)) ?? "CRLF",
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
    if (req.tailOffset !== null) {
      if (!existing || req.tailOffset > existing.bytes.length) throw "STALE";
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

  reset(): void {
    this.saveAnswers = [];
    this.openAnswers = [];
    this.saveRequests = [];
    this.openedUrls = [];
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
  }),
  opener: () => ({
    openUrl: async (url: string) => {
      dialogs.openedUrls.push(url);
    },
  }),
};
