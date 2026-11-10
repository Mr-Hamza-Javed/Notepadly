// Link and image path resolution, plus the host hooks the widgets call into.
import { convertFileSrc } from "@tauri-apps/api/core";

export const previewContext: {
  baseDir: () => string | null;
  openLink: (href: string) => void;
} = {
  baseDir: () => null,
  openLink: () => undefined,
};

const WINDOWS_ABSOLUTE = /^([a-z]:[\\/]|\\\\)/i;

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

export function resolveImageSrc(src: string): string {
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return src;
  const path = joinBase(src);
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
