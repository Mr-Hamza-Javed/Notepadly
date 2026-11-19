// Link and image path resolution, plus the host hooks the widgets call into.
import { StateEffect } from "@codemirror/state";
import { convertFileSrc } from "@tauri-apps/api/core";
import { fileUrlToPath, resolveDocPath } from "../../state/logic";

export const previewContext: {
  baseDir: () => string | null;
  openLink: (href: string) => void;
  /** False while the rest of the active tab's file is still to be loaded. */
  isFullyLoaded: () => boolean;
} = {
  baseDir: () => null,
  openLink: () => undefined,
  isFullyLoaded: () => true,
};

/**
 * The document was saved under another path, so relative images must be resolved again
 * (BUGS.md PREV-7). Dispatched by `EditorEngine.pathChanged`.
 */
export const documentPathChanged = StateEffect.define<null>();

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
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
export function networkHost(path: string): string | null {
  if (!/^[\\/]{2}/.test(path)) return null;
  if (/^[\\/]{2}\?[\\/][a-z]:([\\/]|$)/i.test(path)) return null;
  const unc = /^[\\/]{2}\?[\\/]UNC[\\/]([^\\/]*)/i.exec(path);
  return (unc ? unc[1] : /^[\\/]{2}([^\\/]*)/.exec(path)![1]).toLowerCase();
}

/**
 * False for a network path on a server other than the one the document is on: reading
 * `\\server\x.png` makes Windows send the user's NTLM credentials there (BUGS.md PREV-3, SEC-2).
 */
export function mayLoadImageFrom(path: string, baseDir: string | null): boolean {
  const host = networkHost(path);
  return host === null || (baseDir !== null && networkHost(baseDir) === host);
}

export function resolveImageSrc(src: string): string {
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return src;
  // file:///C:/x.png is a local file like any other (BUGS.md L14).
  // A leading slash starts at the drive or share root, as for links (BUGS.md PREV-8). A relative
  // path in an untitled tab has no folder to start from, so nothing is loaded.
  const path = /^file:/i.test(src)
    ? fileUrlToPath(src.split(/[?#]/)[0])
    : resolveDocPath(previewContext.baseDir(), decodePath(src));
  if (!path) return "";
  // Opening a document must not make Windows connect to a server it names: reading
  // `\\server\x.png` sends the user's NTLM credentials there (BUGS.md PREV-3). Images on the
  // document's own server still load.
  if (!mayLoadImageFrom(path, previewContext.baseDir())) return "";
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
