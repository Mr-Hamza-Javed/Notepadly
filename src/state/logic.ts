// Pure helpers: no store, no engine, no Tauri. Everything here is unit-checkable.
import type { Encoding, Eol, FileStamp } from "../lib/ipc";
import type { FormatMode, ScrollSnapshot } from "../editor/api";
import type { PageSetup, Settings, TabMeta } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  fontFamily: "Inter",
  fontStyle: "Medium",
  fontSizePt: 11,
  wordWrap: true,
  formatting: true,
  openFilesIn: "tab",
  startup: "continue",
  background: true,
  autoUpdate: true,
  recentFiles: true,
  spellcheck: false,
  autocorrect: true,
  statusBar: true,
  zoom: 100,
};

export const DEFAULT_PAGE_SETUP: PageSetup = {
  orientation: "portrait",
  marginMm: 20,
  header: "",
  footer: "",
};

export const MAX_RECENT = 10;
export const UNTITLED = "Untitled";

const oneOf = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const str = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);

export function clampZoom(zoom: number): number {
  return Math.min(500, Math.max(10, Math.round(zoom)));
}

export function sanitizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    theme: oneOf(r.theme, ["light", "dark", "system"] as const, d.theme),
    fontFamily: str(r.fontFamily, d.fontFamily) || d.fontFamily,
    fontStyle: oneOf(r.fontStyle, ["Light", "Regular", "Medium", "Semibold", "Bold"], d.fontStyle),
    fontSizePt: Math.min(96, Math.max(6, num(r.fontSizePt, d.fontSizePt))),
    wordWrap: bool(r.wordWrap, d.wordWrap),
    formatting: bool(r.formatting, d.formatting),
    openFilesIn: oneOf(r.openFilesIn, ["tab", "window"] as const, d.openFilesIn),
    startup: oneOf(r.startup, ["continue", "new"] as const, d.startup),
    background: bool(r.background, d.background),
    autoUpdate: bool(r.autoUpdate, d.autoUpdate),
    recentFiles: bool(r.recentFiles, d.recentFiles),
    spellcheck: bool(r.spellcheck, d.spellcheck),
    autocorrect: bool(r.autocorrect, d.autocorrect),
    statusBar: bool(r.statusBar, d.statusBar),
    zoom: clampZoom(num(r.zoom, d.zoom)),
  };
}

export function sanitizePageSetup(raw: unknown): PageSetup {
  const d = DEFAULT_PAGE_SETUP;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    orientation: oneOf(r.orientation, ["portrait", "landscape"] as const, d.orientation),
    marginMm: Math.min(100, Math.max(0, num(r.marginMm, d.marginMm))),
    header: str(r.header, d.header),
    footer: str(r.footer, d.footer),
  };
}

export function sanitizeRecent(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, MAX_RECENT);
}

export function computeDark(theme: Settings["theme"], systemDark: boolean): boolean {
  return theme === "system" ? systemDark : theme === "dark";
}

export function fontWeightOf(style: string): number {
  const weights: Record<string, number> = { Light: 300, Regular: 400, Medium: 500, Semibold: 600, Bold: 700 };
  return weights[style] ?? 400;
}

/** CSS font-family list: the chosen family, then the system UI stack. */
export function fontStack(family: string): string {
  const quoted = `"${family.replace(/["\\]/g, "")}"`;
  return `${quoted}, "Segoe UI Variable Text", "Segoe UI", sans-serif`;
}

/**
 * The font list in Settings (L6): installed fonts plus the current one. The
 * default "Inter" is not bundled, so it is listed only when installed or chosen,
 * and a chosen font that is not installed says so once the list is known.
 */
export function fontOptions(current: string, installed: string[]): { value: string; label: string }[] {
  const has = (name: string) => installed.some((f) => f.toLowerCase() === name.toLowerCase());
  const names = [current, ...installed.filter((f) => f.toLowerCase() !== current.toLowerCase())];
  return Array.from(new Set(names))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => ({ value: n, label: n === current && installed.length > 0 && !has(n) ? `${n} (not installed)` : n }));
}

// ---- Paths ----------------------------------------------------------------

export function fileNameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

export function dirOf(path: string): string | null {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : null;
}

/** Lower-case extension with its dot, or "" when there is none. */
export function extOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".mdx"];
export const isMarkdownPath = (path: string) => MARKDOWN_EXTENSIONS.includes(extOf(path));

/** Windows paths: separators and case do not matter. */
export function pathsEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function resolveRelative(baseDir: string, relative: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith("\\\\")) return relative;
  const parts = baseDir.split(/[\\/]/);
  for (const piece of relative.split(/[\\/]/)) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(piece);
  }
  return parts.join("\\");
}

export type HrefTarget =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string }
  /** A document or media file that is not text: opened with its default app. */
  | { kind: "external"; path: string }
  | { kind: "none" };

/**
 * Linked files that are not text, so they must not open in a tab. Only these reach
 * the system's default app: a link to a program or script still opens as text.
 */
const EXTERNAL_EXTENSIONS = new Set(
  (
    ".pdf .png .jpg .jpeg .gif .webp .bmp .svg .avif .ico .tif .tiff .heic " +
    ".mp3 .wav .ogg .flac .m4a .mp4 .mkv .webm .mov .avi .wmv " +
    ".docx .xlsx .pptx .doc .xls .ppt .odt .ods .odp .rtf .epub"
  ).split(" "),
);

/** A wikilink names a note: `[[v1.2 notes]]` is `v1.2 notes.md` unless it names a known file type. */
const WIKI_FILE_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, ".txt", ".canvas", ...EXTERNAL_EXTENSIONS]);

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // Not percent-encoded: use as written.
    return text;
  }
}

/** `file:///C:/a%20b.md` → `C:\a b.md`, `file://server/share/x.md` → `\\server\share\x.md`. */
export function fileUrlToPath(url: string): string | null {
  const match = /^file:\/\/([^/\\]*)([/\\].*)?$/i.exec(url);
  if (!match) return null;
  const host = match[1];
  const path = decodeComponent(match[2] ?? "").replace(/\//g, "\\");
  if (host && host.toLowerCase() !== "localhost") return `\\\\${host}${path}`;
  const drive = /^\\([a-zA-Z]:)(\\.*)?$/.exec(path);
  return drive ? `${drive[1]}${drive[2] ?? "\\"}` : null;
}

/** `C:` for `C:\notes`, `\\server\share` for a network folder. */
function rootOf(dir: string): string | null {
  const drive = /^[a-zA-Z]:/.exec(dir);
  if (drive) return drive[0];
  const share = /^\\\\[^\\/]+[\\/][^\\/]+/.exec(dir);
  return share ? share[0] : null;
}

/**
 * Decides what a link in a document may do. Only web and mail links reach the
 * system opener: a document must not be able to launch arbitrary URI handlers.
 */
export function classifyHref(href: string, baseDir: string | null): HrefTarget {
  const value = href.trim();
  if (!value || value.startsWith("#")) return { kind: "none" };
  if (/^(https?:|mailto:)/i.test(value)) return { kind: "web", url: value };
  const wiki = /^wikilink:(.*)$/i.exec(value);
  let target: string;
  if (wiki) {
    // Wikilinks are written as plain names, never percent-encoded.
    target = wiki[1].split("#")[0].trim();
    if (target && !WIKI_FILE_EXTENSIONS.has(extOf(target))) target += ".md";
  } else if (/^file:/i.test(value)) {
    const path = fileUrlToPath(value.split(/[?#]/)[0]);
    if (!path) return { kind: "none" };
    target = path;
  } else {
    const isDrive = /^[a-zA-Z]:[\\/]/.test(value);
    if (!isDrive && /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(value)) return { kind: "none" };
    // Split off the fragment first, so an encoded `%23` stays part of the name.
    target = decodeComponent(value.split("#")[0]);
  }
  if (!wiki) {
    // A link to a folder has nothing to open.
    if (/[\\/]$/.test(target)) return { kind: "none" };
    if (target && !extOf(target)) target += ".md";
  }
  if (!target) return { kind: "none" };
  let path: string;
  if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\")) {
    path = target;
  } else if (!baseDir) {
    return { kind: "none" };
  } else if (/^[\\/]/.test(target)) {
    // `/docs/a.md` starts at the root of the document's drive or share.
    const root = rootOf(baseDir);
    if (!root) return { kind: "none" };
    path = resolveRelative(root, target);
  } else {
    path = resolveRelative(baseDir, target);
  }
  return EXTERNAL_EXTENSIONS.has(extOf(path)) ? { kind: "external", path } : { kind: "file", path };
}

// ---- Modes, titles, names -------------------------------------------------

export function defaultModeFor(path: string | null, formatting: boolean): FormatMode {
  if (!formatting) return "plain";
  return path === null || isMarkdownPath(path) ? "formatted" : "plain";
}

/** Keeps a chosen syntax view when the new name is still markdown. */
export function modeAfterSave(prev: FormatMode, path: string, formatting: boolean): FormatMode {
  if (!isMarkdownPath(path)) return "plain";
  return prev === "plain" ? defaultModeFor(path, formatting) : prev;
}

export function firstLineOf(text: string): string {
  const end = text.indexOf("\n");
  return end < 0 ? text : text.slice(0, end);
}

export function deriveTitle(firstLine: string): string {
  const trimmed = firstLine.replace(/^[#*\->\s]+|[#*\->\s]+$/g, "");
  if (!trimmed) return UNTITLED;
  return Array.from(trimmed).slice(0, 40).join("");
}

export function defaultExtension(mode: FormatMode): string {
  return mode === "plain" ? ".txt" : ".md";
}

/** Windows reserves these device names, with any extension (`con.md` too). */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\s*(\.|$))/i;

export function suggestedFileName(tab: Pick<TabMeta, "path" | "title" | "mode">): string {
  if (tab.path) return fileNameOf(tab.path);
  const safe = tab.title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/, "")
    .trim()
    .replace(DEVICE_NAME, "$1_");
  return `${safe || UNTITLED}${defaultExtension(tab.mode)}`;
}

/**
 * The path a Save As writes to. The dialog has already added the selected
 * filter's extension and asked about overwriting that exact name, so nothing
 * is added here: with "All files" a name like `LICENSE` stays as typed.
 * Windows drops trailing dots and spaces from a file name, so they are dropped
 * here too; otherwise the tab would name a file that is not on disk under that
 * spelling.
 */
export function chosenSavePath(path: string): string {
  const name = fileNameOf(path);
  const trimmed = name.replace(/[. ]+$/, "");
  return trimmed ? path.slice(0, path.length - name.length) + trimmed : path;
}

const FILTER_MD = { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mdx"] };
const FILTER_TXT = { name: "Text", extensions: ["txt"] };
const FILTER_ALL = { name: "All files", extensions: ["*"] };

/** The native dialog preselects the first filter, so it decides the default extension. */
export function saveFilters(mode: FormatMode) {
  return mode === "plain" ? [FILTER_TXT, FILTER_MD, FILTER_ALL] : [FILTER_MD, FILTER_TXT, FILTER_ALL];
}
export const openFilters = () => [FILTER_ALL, FILTER_MD, FILTER_TXT];

/**
 * Short time and date in the user's format, as Notepad's F5 does: `10:30 AM 11/10/2026`
 * in the US, `10:30 10/11/2026` in the UK, `10:30 10.11.2026` in Germany. `locale`
 * defaults to the WebView's locale.
 */
export function formatDateTime(d: Date, locale?: string): string {
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const date = d.toLocaleDateString(locale, { year: "numeric", month: "numeric", day: "numeric" });
  // ICU puts a narrow no-break space before AM/PM; a plain space is what people type.
  return `${time} ${date}`.replace(/[  ]/g, " ");
}

export function pushRecent(list: string[], path: string): string[] {
  return [path, ...list.filter((p) => !pathsEqual(p, path))].slice(0, MAX_RECENT);
}

/**
 * H12: several windows share one settings record. A window writes only the keys
 * it changed itself since its last write, on top of what another window stored.
 */
export function mergeSettings(stored: Settings, written: Settings, mine: Settings): Settings {
  const merged = { ...stored } as Record<keyof Settings, unknown>;
  for (const key of Object.keys(mine) as (keyof Settings)[]) {
    if (mine[key] !== written[key]) merged[key] = mine[key];
  }
  return merged as unknown as Settings;
}

/**
 * The Recent list version of mergeSettings: the paths this window moved up or
 * added go in front, the ones it removed go away, the rest keep the stored order.
 */
export function mergeRecent(stored: string[], written: string[], mine: string[]): string[] {
  const indexIn = (list: string[], path: string) => list.findIndex((p) => pathsEqual(p, path));
  const removed = written.filter((p) => indexIn(mine, p) < 0);
  const front = mine.filter((p, i) => {
    const before = indexIn(written, p);
    return before < 0 || i < before;
  });
  const rest = stored.filter((p) => indexIn(front, p) < 0 && indexIn(removed, p) < 0);
  return [...front, ...rest].slice(0, MAX_RECENT);
}

// ---- Tabs -----------------------------------------------------------------

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.min(Math.max(0, to), next.length), 0, item);
  return next;
}

/** The right neighbour takes over from a closed tab, else the left one. */
export function neighbourAfterClose(ids: string[], closing: string): string | null {
  const index = ids.indexOf(closing);
  if (index < 0 || ids.length < 2) return null;
  return index + 1 < ids.length ? ids[index + 1] : ids[index - 1];
}

export function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

export function stampsEqual(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Where the loaded region ends after a partial save. Rust wrote the encoded
 * text followed by the untouched tail, so the tail's length is the same before
 * and after: this holds for every encoding and needs no re-read.
 * Null means the numbers are inconsistent and the caller must re-read.
 */
export function loadedOffsetAfterPartialSave(
  newSize: number,
  oldSize: number,
  tailOffset: number,
): number | null {
  const tailBytes = oldSize - tailOffset;
  const next = newSize - tailBytes;
  return tailBytes < 0 || next < 0 ? null : next;
}

export type DismissedChange = FileStamp | "deleted" | null;
export type ExternalAction =
  | "none"
  | "flag-modified"
  | "flag-deleted"
  | "clear-flag"
  | "reload"
  | "adopt-stamp";

export function decideExternal(
  tab: Pick<TabMeta, "stamp" | "dirty" | "externalChange">,
  disk: FileStamp | null,
  dismissed: DismissedChange,
  hasDoc: boolean,
): ExternalAction {
  if (disk === null) {
    if (tab.externalChange === "deleted" || dismissed === "deleted" || tab.stamp === null) return "none";
    return "flag-deleted";
  }
  if (stampsEqual(disk, tab.stamp)) return tab.externalChange || dismissed ? "clear-flag" : "none";
  if (dismissed && dismissed !== "deleted" && stampsEqual(disk, dismissed)) return "none";
  if (tab.dirty) return tab.externalChange === "modified" ? "none" : "flag-modified";
  return hasDoc ? "reload" : "adopt-stamp";
}

// ---- Session --------------------------------------------------------------

export interface SessionTab {
  id: string;
  path: string | null;
  title: string;
  dirty: boolean;
  mode: FormatMode;
  eol: Eol;
  encoding: Encoding;
  stamp: FileStamp | null;
  loadedOffset: number;
  fullyLoaded: boolean;
  hasDraft: boolean;
  snap: ScrollSnapshot | null;
}

export interface SessionFile {
  v: 1;
  activeId: string;
  tabs: SessionTab[];
}

function parseStamp(raw: unknown): FileStamp | null {
  const r = raw as FileStamp | null;
  return r && typeof r.size === "number" && typeof r.mtimeMs === "number"
    ? { size: r.size, mtimeMs: r.mtimeMs }
    : null;
}

function parseSnap(raw: unknown): ScrollSnapshot | null {
  const r = raw as ScrollSnapshot | null;
  return r && typeof r.anchor === "number" && typeof r.head === "number" && typeof r.scrollTop === "number"
    ? { anchor: r.anchor, head: r.head, scrollTop: r.scrollTop }
    : null;
}

export function parseSession(raw: string | null): SessionFile | null {
  if (!raw) return null;
  let data: { activeId?: unknown; tabs?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.tabs)) return null;
  const tabs: SessionTab[] = [];
  const seen = new Set<string>();
  for (const item of data.tabs as Record<string, unknown>[]) {
    if (!item || typeof item.id !== "string" || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    tabs.push({
      id: item.id,
      path: typeof item.path === "string" ? item.path : null,
      title: str(item.title, UNTITLED),
      dirty: bool(item.dirty, false),
      mode: oneOf(item.mode, ["formatted", "syntax", "plain"] as const, "plain"),
      eol: oneOf(item.eol, ["CRLF", "LF", "CR"] as const, "CRLF"),
      encoding: oneOf(item.encoding, ["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "ansi"] as const, "utf-8"),
      stamp: parseStamp(item.stamp),
      loadedOffset: Math.max(0, num(item.loadedOffset, 0)),
      fullyLoaded: bool(item.fullyLoaded, false),
      hasDraft: bool(item.hasDraft, false),
      snap: parseSnap(item.snap),
    });
  }
  const activeId = typeof data.activeId === "string" && seen.has(data.activeId) ? data.activeId : tabs[0]?.id ?? "";
  return { v: 1, activeId, tabs };
}

export function tabFromSession(s: SessionTab): TabMeta {
  return {
    id: s.id,
    path: s.path,
    title: s.title,
    dirty: s.dirty && s.hasDraft,
    mode: s.mode,
    eol: s.eol,
    encoding: s.encoding,
    stamp: s.stamp,
    loadedOffset: s.loadedOffset,
    fullyLoaded: s.fullyLoaded,
    tailChars: null,
    externalChange: null,
    hibernated: !(s.dirty && s.hasDraft) && s.path !== null,
  };
}

// ---- Print header and footer ----------------------------------------------

export interface MarginBoxes {
  left: string;
  center: string;
  right: string;
}

const cssString = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

/**
 * Turns a Notepad-style header spec into CSS `content` values. Codes:
 * &f file name, &p page number, &d date, &t time, &l &c &r alignment, && ampersand.
 */
export function headerFooterBoxes(spec: string, ctx: { fileName: string; date: string; time: string }): MarginBoxes {
  type Section = keyof MarginBoxes;
  const parts: Record<Section, string[]> = { left: [], center: [], right: [] };
  let section: Section = "center";
  let literal = "";
  const flush = () => {
    if (literal) parts[section].push(cssString(literal));
    literal = "";
  };
  for (let i = 0; i < spec.length; i++) {
    const code = spec[i] === "&" && i + 1 < spec.length ? spec[i + 1].toLowerCase() : "";
    if (!"fpdtlcr&".includes(code) || !code) {
      literal += spec[i];
      continue;
    }
    i++;
    if (code === "&") literal += "&";
    else if (code === "f") literal += ctx.fileName;
    else if (code === "d") literal += ctx.date;
    else if (code === "t") literal += ctx.time;
    else if (code === "p") {
      flush();
      parts[section].push("counter(page)");
    } else {
      flush();
      section = code === "l" ? "left" : code === "r" ? "right" : "center";
    }
  }
  flush();
  const content = (s: Section) => (parts[s].length ? parts[s].join(" ") : "none");
  return { left: content("left"), center: content("center"), right: content("right") };
}
