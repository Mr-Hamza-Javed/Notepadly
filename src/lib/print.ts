// Printing: renders the whole document into a hidden root, prints, cleans up.
import { convertFileSrc } from "@tauri-apps/api/core";
import { engine } from "../editor";
import { ensureFullyLoaded } from "./loader";
import { dirOf, fileNameOf, fontStack, fontWeightOf, headerFooterBoxes, resolveRelative } from "../state/logic";
import { getTab, useApp } from "../state/store";
import type { TabMeta } from "../state/types";

const ROOT_ID = "notepadly-print-root";
const STYLE_ID = "notepadly-print-style";
const IMAGE_WAIT_MS = 3000;

const ALLOWED_TAGS = new Set(
  ("a abbr b blockquote br code col colgroup dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img input ins kbd " +
    "li mark ol p pre s section small span strong sub summary sup table tbody td tfoot th thead tr u ul").split(" "),
);
const DROPPED_WITH_CONTENT = new Set("script style iframe object embed svg math template noscript".split(" "));
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "alt", "width", "height"],
  input: ["type", "checked", "disabled"],
  ol: ["start"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};
const COMMON_ATTRS = ["align", "title"];

function safeImageSrc(src: string, baseDir: string | null): string | null {
  if (/^(https?:|data:image\/)/i.test(src)) return src;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(src) && !/^[a-zA-Z]:[\\/]/.test(src)) return null;
  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    // Use as written.
  }
  if (/^[a-zA-Z]:[\\/]/.test(decoded)) return convertFileSrc(decoded);
  return baseDir ? convertFileSrc(resolveRelative(baseDir, decoded)) : null;
}

/**
 * Documents are untrusted and this page can reach the Tauri IPC, so rendered
 * markdown goes through an allow-list inside an inert template before it can
 * touch the live DOM.
 */
export function sanitizeHtml(html: string, baseDir: string | null): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (DROPPED_WITH_CONTENT.has(tag)) {
      element.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag) || (tag === "input" && element.getAttribute("type") !== "checkbox")) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag] ?? [];
    for (const { name } of Array.from(element.attributes)) {
      if (!allowed.includes(name) && !COMMON_ATTRS.includes(name)) element.removeAttribute(name);
    }
    const href = element.getAttribute("href");
    if (href !== null && !/^(https?:|mailto:|#)/i.test(href)) element.removeAttribute("href");
    if (tag === "img") {
      const src = safeImageSrc(element.getAttribute("src") ?? "", baseDir);
      if (src) element.setAttribute("src", src);
      else element.removeAttribute("src");
    }
  }
  return template.content;
}

function buildStyle(tab: TabMeta): string {
  const { pageSetup, settings } = useApp.getState();
  const now = new Date();
  const ctx = {
    fileName: tab.path ? fileNameOf(tab.path) : tab.title,
    date: now.toLocaleDateString(),
    time: now.toLocaleTimeString(),
  };
  const top = headerFooterBoxes(pageSetup.header, ctx);
  const bottom = headerFooterBoxes(pageSetup.footer, ctx);
  const box = (name: string, content: string) => `@${name}{content:${content};font:9pt ${fontStack("Segoe UI")};color:#444}`;
  const font = `${fontWeightOf(settings.fontStyle)} ${settings.fontSizePt}pt/1.5 ${fontStack(settings.fontFamily)}`;
  return `
@media screen{#${ROOT_ID}{display:none}}
@media print{
  html,body{height:auto!important;overflow:visible!important;background:#fff!important;color-scheme:light}
  body>*:not(#${ROOT_ID}){display:none!important}
  #${ROOT_ID}{display:block;color:#000;font:${font};overflow-wrap:anywhere}
  #${ROOT_ID} pre{white-space:pre-wrap;margin:0;font:inherit;tab-size:4}
  #${ROOT_ID} code{font-family:Consolas,monospace;font-size:.92em}
  #${ROOT_ID} table{border-collapse:collapse}
  #${ROOT_ID} th,#${ROOT_ID} td{border:1px solid #999;padding:3px 8px}
  #${ROOT_ID} blockquote{margin-left:0;padding-left:12px;border-left:3px solid #bbb}
  #${ROOT_ID} img{max-width:100%}
  #${ROOT_ID} h1,#${ROOT_ID} h2,#${ROOT_ID} h3{break-after:avoid}
}
@page{
  size:${pageSetup.orientation};
  margin:${pageSetup.marginMm}mm;
  ${box("top-left", top.left)}${box("top-center", top.center)}${box("top-right", top.right)}
  ${box("bottom-left", bottom.left)}${box("bottom-center", bottom.center)}${box("bottom-right", bottom.right)}
}`;
}

function cleanup(): void {
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
}

function imagesReady(root: HTMLElement): Promise<unknown> {
  const pending = Array.from(root.querySelectorAll("img"))
    .filter((image) => !image.complete)
    .map((image) => new Promise((resolve) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    }));
  return Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, IMAGE_WAIT_MS))]);
}

export async function printTab(id: string): Promise<void> {
  await ensureFullyLoaded(id);
  const tab = getTab(id);
  if (!tab) return;
  const text = engine.getText(id);
  cleanup();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  if (tab.mode === "formatted") {
    const { marked } = await import("marked");
    const html = marked.parse(text, { async: false, gfm: true }) as string;
    root.appendChild(sanitizeHtml(html, tab.path ? dirOf(tab.path) : null));
  } else {
    const pre = document.createElement("pre");
    pre.textContent = text;
    root.appendChild(pre);
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = buildStyle(tab);
  document.head.appendChild(style);
  document.body.appendChild(root);
  await imagesReady(root);

  // The print preview re-reads the DOM when options change, so the root stays
  // until the dialog is finished. A later print also clears any leftovers.
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
}
