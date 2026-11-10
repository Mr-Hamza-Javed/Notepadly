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

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];
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

export type HrefTarget = { kind: "web"; url: string } | { kind: "file"; path: string } | { kind: "none" };

/**
 * Decides what a link in a document may do. Only web and mail links reach the
 * system opener: a document must not be able to launch arbitrary URI handlers.
 */
export function classifyHref(href: string, baseDir: string | null): HrefTarget {
  const value = href.trim();
  if (!value || value.startsWith("#")) return { kind: "none" };
  if (/^(https?:|mailto:)/i.test(value)) return { kind: "web", url: value };
  const wiki = /^wikilink:(.*)$/i.exec(value);
  const isDrive = /^[a-zA-Z]:[\\/]/.test(value);
  if (!wiki && !isDrive && /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(value)) return { kind: "none" };
  let target = (wiki ? wiki[1] : value).split("#")[0];
  try {
    target = decodeURI(target);
  } catch {
    // Not percent-encoded: use as written.
  }
  if (!target) return { kind: "none" };
  if (!extOf(target)) target += ".md";
  if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\")) return { kind: "file", path: target };
  return baseDir ? { kind: "file", path: resolveRelative(baseDir, target) } : { kind: "none" };
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

export function suggestedFileName(tab: Pick<TabMeta, "path" | "title" | "mode">): string {
  if (tab.path) return fileNameOf(tab.path);
  const safe = tab.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/[. ]+$/, "").trim();
  return `${safe || UNTITLED}${defaultExtension(tab.mode)}`;
}

export function withDefaultExtension(path: string, mode: FormatMode): string {
  return extOf(path) ? path : path + defaultExtension(mode);
}

const FILTER_MD = { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] };
const FILTER_TXT = { name: "Text", extensions: ["txt"] };
const FILTER_ALL = { name: "All files", extensions: ["*"] };

/** The native dialog preselects the first filter, so it decides the default extension. */
export function saveFilters(mode: FormatMode) {
  return mode === "plain" ? [FILTER_TXT, FILTER_MD, FILTER_ALL] : [FILTER_MD, FILTER_TXT, FILTER_ALL];
}
export const openFilters = () => [FILTER_ALL, FILTER_MD, FILTER_TXT];

/** Local `h:mm tt M/d/yyyy`, e.g. `10:30 AM 11/10/2026`. */
export function formatDateTime(d: Date): string {
  const hours = d.getHours();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${h12}:${minutes} ${hours < 12 ? "AM" : "PM"} ${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export function pushRecent(list: string[], path: string): string[] {
  return [path, ...list.filter((p) => !pathsEqual(p, path))].slice(0, MAX_RECENT);
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
    totalChars: null,
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
