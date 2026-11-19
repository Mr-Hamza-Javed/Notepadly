// Link and image path resolution, plus the host hooks the widgets call into.
import { convertFileSrc } from "@tauri-apps/api/core";
import { fileUrlToPath } from "../../state/logic";

export const previewContext: {
  baseDir: () => string | null;
  openLink: (href: string) => void;
} = {
  baseDir: () => null,
  openLink: () => undefined,
};

const WINDOWS_ABSOLUTE = /^([a-z]:[\\/]|[\\/]{2})/i;

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function joinBase(path: string): string {
  const clean = decodePath(path.replace(/^\.[\\/]/, ""));
  if (WINDOWS_ABSOLUTE.test(clean)) return clean;
  const base = previewContext.baseDir();
  if (!base) return clean;
  return `${base.replace(/[\\/]+$/, "")}\\${clean.replace(/\//g, "\\")}`;
}

/** Turns a Markdown link target into what `EditorHost.openLink` receives: relative hrefs pass through. */
export function resolveHref(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url;
}

/** The host resolves `wikilink:Target` to the sibling `.md` file; a `#heading` suffix is dropped. */
export function resolveWikiTarget(target: string): string {
  return `wikilink:${target.split("#")[0].trim()}`;
}

/**
 * The server of a network path (`\\server\share`, `//server/share`, `\\?\UNC\server\...`),
 * lower-cased, or null for a local path. Device paths (`\\.\pipe\x`) give "." and are never local.
 */
function networkHost(path: string): string | null {
  if (!/^[\\/]{2}/.test(path)) return null;
  if (/^[\\/]{2}\?[\\/][a-z]:([\\/]|$)/i.test(path)) return null;
  const unc = /^[\\/]{2}\?[\\/]UNC[\\/]([^\\/]*)/i.exec(path);
  return (unc ? unc[1] : /^[\\/]{2}([^\\/]*)/.exec(path)![1]).toLowerCase();
}

export function resolveImageSrc(src: string): string {
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return src;
  // file:///C:/x.png is a local file like any other (BUGS.md L14).
  const path = /^file:/i.test(src) ? (fileUrlToPath(src.split(/[?#]/)[0]) ?? src) : joinBase(src);
  // Opening a document must not make Windows connect to a server it names: reading
  // `\\server\x.png` sends the user's NTLM credentials there (BUGS.md PREV-3). Images on the
  // document's own server still load.
  const host = networkHost(path);
  if (host !== null) {
    const base = previewContext.baseDir();
    if (!base || networkHost(base) !== host) return "";
  }
  return "__TAURI_INTERNALS__" in window ? convertFileSrc(path) : path;
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(path.split("#")[0].trim());
}

/** Reads Obsidian's `|200` or `|200x100` size suffix. */
export function parseSize(text: string): { width?: number; height?: number } | null {
  const match = /^(\d+)(?:x(\d+))?$/.exec(text.trim());
  if (!match) return null;
  return { width: Number(match[1]), height: match[2] ? Number(match[2]) : undefined };
}
