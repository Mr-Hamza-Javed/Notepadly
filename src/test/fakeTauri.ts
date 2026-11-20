// An in-memory stand-in for the Rust side, at the IPC boundary only. It follows the
// contract in src/lib/ipc.ts and the behaviour of src-tauri/src/files.rs and
// store.rs closely enough for the frontend's loading, saving and change detection
// to be exercised for real: byte offsets, chunk cuts (last LF, or a CR that is not
// the window's last byte, else a UTF-8 character boundary), CRLF/LF/CR, the UTF-8
// BOM, tail saves, STALE rejections, missing folders and draft id validation.
//
// Known differences from Rust, none of which the frontend tests rely on:
// - UTF-8 (with or without BOM), UTF-16 LE/BE (with or without BOM), ANSI and
//   OEM are modelled; ANSI and OEM are both always windows-1252. Like Rust, the
//   first 256 KiB decide the encoding, and an encoding passed at offset 0 forces
//   it (a UTF-16 or UTF-8 choice then follows whether the file has a BOM).
// - Writes are not atomic and there is no ReplaceFileW / in-place fallback.
// - Mixed line endings are kept on save like files.rs `kept_line_endings`, but
//   without its 64 MiB limit.
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

const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];
const isUtf16 = (encoding: string) => encoding.startsWith("utf-16");
const bigEndian = (encoding: string) => encoding.startsWith("utf-16be");
const singleByte = (encoding: string) => encoding === "ansi" || encoding === "oem";
const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((b, i) => bytes[i] === b);

/** The length of the BOM `bytes` start with, for files read in `encoding`. */
function bomLength(bytes: Uint8Array, encoding: string): number {
  if (singleByte(encoding)) return 0;
  if (isUtf16(encoding)) return startsWith(bytes, bigEndian(encoding) ? BOM_UTF16BE : BOM_UTF16LE) ? 2 : 0;
  return startsWith(bytes, BOM) ? 3 : 0;
}

/** files.rs `forced_encoding`: UTF-8 and UTF-16 follow whether the file has a BOM. */
function followBom(encoding: string, hasBom: boolean): string {
  if (encoding === "utf-8" && hasBom) return "utf-8-bom";
  if (!isUtf16(encoding)) return encoding;
  const order = bigEndian(encoding) ? "utf-16be" : "utf-16le";
  return hasBom ? order : `${order}-nobom`;
}

function decodeAs(bytes: Uint8Array, encoding: string): string {
  if (singleByte(encoding)) return ansiDecoder.decode(bytes);
  if (isUtf16(encoding)) {
    return new TextDecoder(bigEndian(encoding) ? "utf-16be" : "utf-16le", { ignoreBOM: true }).decode(bytes);
  }
  return decoder.decode(bytes);
}

/** files.rs `encode_str` plus the BOM of the encoding. */
function encodeAs(text: string, encoding: string, lossy: boolean): Uint8Array {
  if (singleByte(encoding)) return encodeAnsi(text, lossy);
  if (isUtf16(encoding)) {
    const bom = encoding.endsWith("-nobom") ? 0 : 2;
    const out = new Uint8Array(bom + text.length * 2);
    if (bom) out.set(bigEndian(encoding) ? BOM_UTF16BE : BOM_UTF16LE);
    const view = new DataView(out.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(bom + i * 2, text.charCodeAt(i), !bigEndian(encoding));
    return out;
  }
  const body = encoder.encode(text);
  return encoding === "utf-8-bom" ? concat(new Uint8Array(BOM), body) : body;
}

/** files.rs `guess_utf16`: mostly-Latin UTF-16 has a zero in every other byte. */
function guessUtf16(head: Uint8Array, complete: boolean): string | null {
  if (head.length < 2 || (complete && head.length % 2 === 1)) return null;
  const pairs = Math.floor(head.length / 2);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < pairs; i++) {
    if (head[i * 2] === 0) even++;
    if (head[i * 2 + 1] === 0) odd++;
  }
  if (odd * 2 >= pairs && even * 8 < odd) return "utf-16le-nobom";
  if (even * 2 >= pairs && odd * 8 < even) return "utf-16be-nobom";
  return null;
}

/** files.rs `cut_utf16`: after the last line break, never inside a CRLF or a surrogate pair. */
function cutUtf16(body: Uint8Array, big: boolean): number {
  const units = Math.floor(body.length / 2);
  const view = new DataView(body.buffer, body.byteOffset, units * 2);
  const unit = (i: number) => view.getUint16(i * 2, !big);
  for (let i = units - 1; i >= 0; i--) {
    if (unit(i) === 10 || (unit(i) === 13 && i + 1 < units)) return (i + 1) * 2;
  }
  if (units === 0) return 0;
  const last = unit(units - 1);
  return last === 13 || (last >= 0xd800 && last <= 0xdbff) ? (units - 1) * 2 : units * 2;
}

/** `firstEol` on decoded text: a CR at the end of an incomplete window may be half a CRLF. */
function firstEolText(text: string, complete: boolean): "CRLF" | "LF" | "CR" | null {
  const at = text.search(/[\r\n]/);
  if (at < 0) return null;
  if (text[at] === "\n") return "LF";
  if (at + 1 < text.length) return text[at + 1] === "\n" ? "CRLF" : "CR";
  return complete ? "CR" : "CRLF";
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
  /** Per-window sessions (store.rs `window_session_*`), by key. */
  windowSessions = new Map<string, string>();
  drafts = new Map<string, string>();
  pendingPaths: string[] = [];
  /** What `take_window_boot` hands the next window that boots; drained once. */
  boot: { restore: string | null; transfer: string | null } = { restore: null, transfer: null };
  /** Answer of `tab_drop_target`: the other window under the mouse. */
  dropTarget: { label: string; x: number; y: number } | null = null;
  /** Answer of `window_drag_result`, given once (window_drag.rs). */
  windowDragEnd: { target: { label: string; x: number; y: number } | null; cancelled: boolean } | null = null;
  /** Every command name, in order. */
  calls: { cmd: string; args: Record<string, unknown>; caller?: string }[] = [];
  /** Next error for a command, by name; consumed once. */
  failNext = new Map<string, string>();
  /** Paths whose reads always fail (a locked file). */
  unreadable = new Set<string>();
  /** Paths whose file has the read-only attribute: reads report it and saves fail. */
  readOnly = new Set<string>();
  /** Draft ids whose reads fail (a draft file that cannot be read). */
  unreadableDrafts = new Set<string>();
  /** When each draft was last written, in Date.now() milliseconds. */
  draftTimes = new Map<string, number>();
  /** When the app process started (bootApp of a first window); drafts written since are this run's. */
  runStartedAt = 0;
  /** Answer of `user_locale`; "" is unknown. */
  locale = "";
  /** False makes `is_last_window` and `window_closing` say another window is on screen. */
  isLastWindow = true;
  /** Labels of the app's windows that are on screen (bootApp adds them). */
  windows = new Set<string>();
  /** Windows that have started closing (`window_closing`, cleared by `window_close_cancelled`). */
  closingWindows = new Set<string>();
  /** The paths each window has open (`open_paths_set`). */
  openPaths = new Map<string, string[]>();
  /** Paths that are another name of a file (an 8.3 name, a mapped drive): alias → real path. */
  aliases = new Map<string, string>();
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
    this.windowDragEnd = null;
    this.calls = [];
    this.failNext.clear();
    this.unreadable.clear();
    this.readOnly.clear();
    this.unreadableDrafts.clear();
    this.draftTimes.clear();
    this.isLastWindow = true;
    this.windows.clear();
    this.closingWindows.clear();
    this.openPaths.clear();
    this.aliases.clear();
    this.locale = "";
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

  private isReadOnly(path: string): boolean {
    return [...this.readOnly].some((p) => key(p) === key(path));
  }

  private stampOf(path: string): FakeStamp | null {
    const file = this.files.get(key(path));
    return file ? { size: file.bytes.length, mtimeMs: file.mtimeMs } : null;
  }

  /** `caller` is the label of the window that sent the command (Rust's `tauri::Window`). */
  async invoke(cmd: string, args: Record<string, unknown> = {}, caller = "main"): Promise<unknown> {
    this.calls.push({ cmd, args, caller });
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
      case "path_identity": {
        // files.rs `path_identity`: the same value for every name of one file.
        const path = args.path as string;
        const real = [...this.aliases].find(([alias]) => key(alias) === key(path))?.[1] ?? path;
        return this.files.has(key(real)) ? `id:${key(real)}` : null;
      }
      case "file_scan": {
        const encoding = args.encoding as string;
        const all = this.bytes(args.path as string);
        const raw = all.subarray(encoding === "utf-8" ? 0 : bomLength(all, encoding));
        const text = normalize(decodeAs(raw, encoding));
        const utf8 = !singleByte(encoding) && !isUtf16(encoding);
        // Code points, like files.rs `scan` (BUGS.md L5).
        return { chars: [...text].length, lines: text.split("\n").length, invalid: utf8 && !isUtf8(raw) };
      }
      case "session_read":
        return this.session;
      case "session_write":
        this.session = args.json as string;
        return null;
      case "drafts_prune": {
        // store.rs `drafts_prune`: a draft created during this run is spared, even
        // when no stored session lists it yet (MERGE-1).
        const keep = args.keep as string[];
        for (const id of [...this.drafts.keys()]) {
          if (keep.includes(id)) continue;
          if ((this.draftTimes.get(id) ?? 0) >= this.runStartedAt) continue;
          this.drafts.delete(id);
          this.draftTimes.delete(id);
        }
        return null;
      }
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
        if (cmd === "draft_read") {
          if (this.unreadableDrafts.has(id)) throw "Access is denied. (os error 5)";
          return this.drafts.get(id) ?? null;
        }
        if (cmd === "draft_write") {
          this.drafts.set(id, args.text as string);
          this.draftTimes.set(id, Date.now());
        } else {
          this.drafts.delete(id);
          this.draftTimes.delete(id);
        }
        return null;
      }
      case "take_pending_paths": {
        const paths = this.pendingPaths;
        this.pendingPaths = [];
        return paths;
      }
      case "is_last_window":
        return this.isLastWindow && [...this.windows].every((w) => w === caller);
      case "window_closing": {
        // Rust decides "last" atomically: windows that started closing do not count.
        this.closingWindows.add(caller);
        return this.isLastWindow && [...this.windows].every((w) => w === caller || this.closingWindows.has(w));
      }
      case "window_close_cancelled":
        this.closingWindows.delete(caller);
        return null;
      case "open_paths_set":
        this.openPaths.set(caller, [...(args.paths as string[])]);
        return null;
      case "path_open_elsewhere": {
        // Rust focuses the window that has the file and asks it to show it.
        const wanted = key(args.path as string);
        for (const [label, paths] of this.openPaths) {
          if (label === caller || !this.windows.has(label) || !paths.some((p) => key(p) === wanted)) continue;
          const win = fakeWindows.get(label);
          if (win) {
            win.focused++;
            const listener = win.listeners.get("open-paths-here");
            if (listener) setTimeout(() => listener({ payload: [args.path] }), 0);
          }
          return label;
        }
        return null;
      }
      case "system_fonts":
        return ["Arial", "Inter", "Segoe UI"];
      case "update_configure":
      case "update_status":
        return { phase: "idle", version: null, message: null, current: "0.1.0", canInstall: false };
      case "user_locale":
        return this.locale;
      case "launched_hidden":
        return false;
      case "window_drag_result": {
        const end = this.windowDragEnd;
        this.windowDragEnd = null;
        return end;
      }
      case "window_drag_start":
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
    if (startsWith(all, BOM_UTF16LE)) return "utf-16le";
    if (startsWith(all, BOM_UTF16BE)) return "utf-16be";
    const utf16 = guessUtf16(all.subarray(0, 256 * 1024), all.length <= 256 * 1024);
    if (utf16) return utf16;
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
    const detected = hint ?? this.detect(all);
    const bom = start === 0 ? bomLength(window, detected) : 0;
    const encoding = start === 0 ? followBom(detected, bom > 0) : detected;
    const body = window.subarray(bom);
    const cut = eof
      ? body.length
      : isUtf16(encoding)
        ? cutUtf16(body, bigEndian(encoding))
        : cutChunk(body, singleByte(encoding));
    // The first chunk detects the line ending from its own window; later chunks
    // repeat what the first 256 KiB of the file says (files.rs `known_format`).
    const head = all.subarray(0, 256 * 1024);
    const eol = isUtf16(encoding)
      ? start === 0
        ? firstEolText(decodeAs(body, encoding), eof)
        : firstEolText(decodeAs(head.subarray(bomLength(head, encoding)), encoding), size <= 256 * 1024)
      : start === 0
        ? firstEol(body, eof)
        : firstEol(this.stripBom(head), size <= 256 * 1024);
    const raw = decodeAs(body.subarray(0, cut), encoding);
    const known = eol ?? "CRLF";
    return {
      text: normalize(raw),
      nextOffset: start + bom + cut,
      eof,
      encoding,
      eol: known,
      stamp: { size, mtimeMs: file.mtimeMs },
      // This chunk holds a line ending other than the file's `eol` (FILES-1).
      mixedEol: endingsOf(raw).some((e) => e !== known),
      readOnly: start === 0 && this.isReadOnly(path),
      binary: raw.includes("\0"),
    };
  }

  private save(req: SaveArgs): FakeStamp {
    const existing = this.files.get(key(req.path));
    const stamp = this.stampOf(req.path);
    if (req.expectedStamp && (stamp === null || stamp.size !== req.expectedStamp.size || stamp.mtimeMs !== req.expectedStamp.mtimeMs)) {
      throw "STALE";
    }
    if (existing && this.isReadOnly(req.path)) throw "Access is denied. (os error 5)";
    const eol = req.eol === "CRLF" ? "\r\n" : req.eol === "CR" ? "\r" : "\n";
    const final = (existing && this.keptLineEndings(existing.bytes, req)) ?? normalize(req.text).replace(/\n/g, eol);
    const parts: Uint8Array[] = [encodeAs(final, req.encoding, !!req.allowLossy)];
    const parent = parentKey(req.path);
    if (parent && !this.dirs.has(parent)) throw "The system cannot find the path specified. (os error 3)";
    if (req.tailOffset !== null) {
      // files.rs `append_tail`: a missing source is an I/O error, a short one is STALE.
      // `tailPath`: Save As streams the rest of another file (M13).
      const source = req.tailPath ? this.files.get(key(req.tailPath)) : existing;
      if (req.tailPath) {
        const tailStamp = this.stampOf(req.tailPath);
        const want = req.tailStamp;
        if (want && (!tailStamp || tailStamp.size !== want.size || tailStamp.mtimeMs !== want.mtimeMs)) throw "STALE";
      }
      if (!source) throw "The system cannot find the file specified. (os error 2)";
      if (req.tailOffset > source.bytes.length) throw "STALE";
      parts.push(source.bytes.subarray(req.tailOffset));
    }
    this.files.set(key(req.path), { bytes: concat(...parts), mtimeMs: (this.clock += 1000) });
    return this.stampOf(req.path) as FakeStamp;
  }

  /** files.rs `kept_line_endings`: null when not mixed or when asked to normalise. */
  private keptLineEndings(bytes: Uint8Array, req: SaveArgs): string | null {
    if (req.normalizeEol) return null;
    const end = Math.min(req.tailOffset ?? bytes.length, bytes.length);
    const original = req.originalEncoding ?? req.encoding;
    const raw = bytes.subarray(0, end);
    const old = splitLines(decodeAs(raw.subarray(original === "utf-8" ? 0 : bomLength(raw, original)), original));
    const first = old.find((l) => l[1] !== null)?.[1];
    if (first === undefined || old.every((l) => l[1] === null || l[1] === first)) return null;
    const next = normalize(req.text).split("\n");
    const fallback = req.eol === "CRLF" ? "\r\n" : req.eol === "CR" ? "\r" : "\n";
    const endings = matchedEndings(old, next, fallback);
    return next.map((line, i) => line + (endings[i] ?? "")).join("");
  }
}

/** The line endings in `text`, in order. */
function endingsOf(text: string): ("CRLF" | "LF" | "CR")[] {
  return (text.match(/\r\n|\r|\n/g) ?? []).map((e) => (e === "\r\n" ? "CRLF" : e === "\r" ? "CR" : "LF"));
}

/** files.rs `split_lines`: each line with the ending after it (none after the last). */
function splitLines(text: string): [string, string | null][] {
  const lines: [string, string | null][] = [];
  const re = /\r\n|\r|\n/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    lines.push([text.slice(start, m.index), m[0]]);
    start = m.index + m[0].length;
  }
  lines.push([text.slice(start), null]);
  return lines;
}

/** files.rs `matched_endings`: unchanged lines keep their ending, changed ones get `fallback`. */
function matchedEndings(old: [string, string | null][], next: string[], fallback: string): string[] {
  const endings = new Array<string>(Math.max(0, next.length - 1)).fill(fallback);
  const keep = (n: number, o: number) => {
    const ending = old[o][1];
    if (n < endings.length && ending !== null) endings[n] = ending;
  };
  if (old.length === next.length) {
    for (let i = 0; i < next.length; i++) keep(i, i);
    return endings;
  }
  const shorter = Math.min(old.length, next.length);
  let prefix = 0;
  while (prefix < shorter && old[prefix][0] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shorter - prefix && old[old.length - 1 - suffix][0] === next[next.length - 1 - suffix]) suffix++;
  for (let i = 0; i < prefix; i++) keep(i, i);
  for (let k = 1; k < suffix; k++) keep(next.length - 1 - k, old.length - 1 - k);
  return endings;
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
  originalEncoding?: string;
  tailPath?: string | null;
  tailStamp?: FakeStamp | null;
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
    if (!prevented) {
      // Closed for good: Rust forgets the window.
      backend.windows.delete(this.label);
      backend.closingWindows.delete(this.label);
      backend.openPaths.delete(this.label);
    }
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
  /** Answers for yes/no questions (`ask`), consumed in order; false when empty. */
  askAnswers: boolean[] = [];
  asked: string[] = [];

  reset(): void {
    this.saveAnswers = [];
    this.openAnswers = [];
    this.saveRequests = [];
    this.openedUrls = [];
    this.messageAnswers = [];
    this.messages = [];
    this.openedPaths = [];
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
  __fakeWindows?: Map<string, FakeWindow>;
};
export const backend = (shared.__fakeBackend ??= new FakeBackend());
export const fakeWindow = (shared.__fakeWindow ??= new FakeWindow());
export const dialogs = (shared.__fakeDialogs ??= new FakeDialogs());
/**
 * The windows that can receive events from each other, by label. bootApp keeps
 * one per booted app, so two apps booted in one test (each with its own
 * FakeWindow and module graph) talk to each other as two real windows would.
 */
export const fakeWindows = (shared.__fakeWindows ??= new Map<string, FakeWindow>());

/** Delivers an event a window sent to the other windows it reaches, after an IPC hop. */
function route(from: FakeWindow, target: string, event: string, payload: unknown): void {
  for (const win of fakeWindows.values()) {
    if (win === from || win.destroyed || (target !== "*" && win.label !== target)) continue;
    const listener = win.listeners.get(event);
    if (listener) setTimeout(() => listener({ payload: structuredClone(payload) }), 0);
  }
}

/**
 * Module factories for vi.mock, so each test file mocks Tauri the same way. `win`
 * is the window the mocked modules belong to (see bootApp's `window` option).
 */
export const tauriMocks = {
  core: (win: FakeWindow = fakeWindow) => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => backend.invoke(cmd, args, win.label),
    convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  }),
  window: (win: FakeWindow = fakeWindow) => ({
    getCurrentWindow: () => ({
      get label() {
        return win.label;
      },
      close: () => win.close(),
      destroy: async () => {
        win.destroyed = true;
        backend.windows.delete(win.label);
        backend.closingWindows.delete(win.label);
        backend.openPaths.delete(win.label);
      },
      setTheme: async () => {},
      unminimize: async () => {},
      show: async () => {},
      setFocus: async () => {
        win.focused++;
      },
      onCloseRequested: async (handler: FakeWindow["closeHandler"]) => {
        win.closeHandler = handler;
        return () => {};
      },
      onFocusChanged: async () => () => {},
      isFocused: async () => false,
    }),
  }),
  webview: () => ({
    getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
  }),
  webviewWindow: (win: FakeWindow = fakeWindow) => ({
    getCurrentWebviewWindow: () => ({
      listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
        win.listeners.set(event, handler);
        win.listenedAt.set(event, backend.calls.length);
        return () => {};
      },
      emit: async (event: string, payload: unknown) => {
        win.emitted.push({ target: "*", event, payload });
        route(win, "*", event, payload);
      },
      emitTo: async (target: string, event: string, payload: unknown) => {
        win.emitted.push({ target, event, payload });
        route(win, target, event, payload);
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
    message: async (body: string, options?: { title?: string }) => {
      dialogs.messages.push({ title: options?.title, body });
      return dialogs.messageAnswers.shift() ?? "Cancel";
    },
    ask: async (message: string) => {
      dialogs.asked.push(message);
      return dialogs.askAnswers.shift() ?? false;
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
