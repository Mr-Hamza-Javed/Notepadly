// Printing: renders the whole document into a hidden root, prints, cleans up.
import { convertFileSrc } from "@tauri-apps/api/core";
import { engine } from "../editor";
import { mayLoadImageFrom } from "../editor/livePreview/context";
import { plainMarkdownParser } from "../editor/markdown";
import { ensureFullyLoaded } from "./loader";
import {
  dirOf,
  fileNameOf,
  fileUrlToPath,
  fontStack,
  fontWeightOf,
  headerFooterBoxes,
  resolveRelative,
} from "../state/logic";
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

/** A local file the printout may load, or null; another server's share is never reached (BUGS.md SEC-2, PREV-9). */
function localImageSrc(path: string, baseDir: string | null): string | null {
  return mayLoadImageFrom(path, baseDir) ? convertFileSrc(path) : null;
}

function safeImageSrc(src: string, baseDir: string | null): string | null {
  if (/^(https?:|data:image\/)/i.test(src)) return src;
  if (/^file:/i.test(src)) {
    const path = fileUrlToPath(src.split(/[?#]/)[0]);
    return path ? localImageSrc(path, baseDir) : null;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(src) && !/^[a-zA-Z]:[\\/]/.test(src)) return null;
  let decoded = src;
  try {
    decoded = decodeURI(src);
  } catch {
    // Use as written.
  }
  if (/^[a-zA-Z]:[\\/]/.test(decoded) || /^[\\/]{2}/.test(decoded)) return localImageSrc(decoded, baseDir);
  return baseDir ? localImageSrc(resolveRelative(baseDir, decoded), baseDir) : null;
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
  #${ROOT_ID} mark{background:#fff3a3;color:inherit}
  #${ROOT_ID} .np-tag{padding:0 6px;border:1px solid #bbb;border-radius:9px;font-size:.9em}
  #${ROOT_ID} .np-wikilink{text-decoration:underline}
  #${ROOT_ID} .np-math-block{margin:.6em 0;text-align:center}
  #${ROOT_ID} .np-mermaid{margin:.6em 0;break-inside:avoid}
  #${ROOT_ID} .np-mermaid svg{max-width:100%;height:auto}
  #${ROOT_ID} blockquote.np-callout{padding:6px 12px;border-left-width:4px;background:#f4f6f8;break-inside:avoid}
  #${ROOT_ID} .np-callout-warning,#${ROOT_ID} .np-callout-caution,#${ROOT_ID} .np-callout-attention{border-left-color:#d97706}
  #${ROOT_ID} .np-callout-danger,#${ROOT_ID} .np-callout-error,#${ROOT_ID} .np-callout-bug,#${ROOT_ID} .np-callout-failure{border-left-color:#dc2626}
  #${ROOT_ID} .np-callout-tip,#${ROOT_ID} .np-callout-success,#${ROOT_ID} .np-callout-check,#${ROOT_ID} .np-callout-done{border-left-color:#16a34a}
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

/** Parts of a note that are never shown on paper. */
const NOT_PRINTED = new Set(["Frontmatter", "CommentBlock", "InlineComment"]);

/** Notepadly syntax that plain `marked` does not know, rendered into the page after sanitising. */
export type PrintPart =
  | { kind: "math"; src: string; display: boolean }
  | { kind: "mermaid"; src: string }
  | { kind: "wikilink"; text: string }
  | { kind: "embed"; target: string; alias: string }
  | { kind: "tag"; text: string }
  | { kind: "callout"; type: string; titled: boolean };

/** Private-use characters: never typed, kept as they are by `marked` and the sanitiser. */
const TOKEN = /\uE000(\d+)\uE001/g;
const token = (index: number) => `\uE000${index}\uE001`;

export interface PrintSource {
  markdown: string;
  parts: PrintPart[];
}

/**
 * The markdown that goes to paper. Front matter and `%%comments%%` are left out, as
 * the editor promises; maths, Mermaid, wikilinks, embeds, tags and callout markers
 * become placeholders that `renderParts` fills in; `==highlights==` become `<mark>`.
 * The editor's own parser finds all of them, so the same text inside code stays as is.
 */
export function preparePrint(text: string): PrintSource {
  const edits: { from: number; to: number; insert: string }[] = [];
  const parts: PrintPart[] = [];
  const add = (from: number, to: number, part: PrintPart, block = false) => {
    const mark = token(parts.push(part) - 1);
    edits.push({ from, to, insert: block ? `\n\n${mark}\n\n` : mark });
  };
  plainMarkdownParser.parse(text).iterate({
    enter: (ref) => {
      const node = ref.node;
      if (NOT_PRINTED.has(ref.name)) {
        edits.push({ from: ref.from, to: ref.to, insert: "" });
        return false;
      }
      switch (ref.name) {
        case "InlineMath":
        case "BlockMath": {
          const marks = node.getChildren("MathMark");
          if (marks.length < 2) return false;
          // Inside a quote or list, the `>` and list markers of later lines are not maths.
          let src = "";
          let at = marks[0].to;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === "MathMark" || child.from < at) continue;
            src += text.slice(at, child.from);
            at = child.to;
          }
          src = (src + text.slice(at, marks[marks.length - 1].from)).trim();
          const display = ref.name === "BlockMath" || marks[0].to - marks[0].from === 2;
          const topLevel = node.parent?.name === "Document";
          add(ref.from, ref.to, { kind: "math", src, display }, ref.name === "BlockMath" && topLevel);
          return false;
        }
        case "FencedCode": {
          const info = node.getChild("CodeInfo");
          if (!info || text.slice(info.from, info.to).trim().toLowerCase() !== "mermaid") return false;
          const body = node.getChild("CodeText");
          const src = body ? text.slice(body.from, body.to) : "";
          add(ref.from, ref.to, { kind: "mermaid", src });
          return false;
        }
        case "HighlightMark": {
          const parent = node.parent;
          edits.push({ from: ref.from, to: ref.to, insert: parent && parent.from === ref.from ? "<mark>" : "</mark>" });
          return false;
        }
        case "WikiLink": {
          const shown = node.getChild("WikiAlias") ?? node.getChild("WikiTarget");
          add(ref.from, ref.to, { kind: "wikilink", text: shown ? text.slice(shown.from, shown.to).trim() : "" });
          return false;
        }
        case "Embed": {
          const target = node.getChild("WikiTarget");
          const alias = node.getChild("WikiAlias");
          add(ref.from, ref.to, {
            kind: "embed",
            target: target ? text.slice(target.from, target.to).trim() : "",
            alias: alias ? text.slice(alias.from, alias.to).trim() : "",
          });
          return false;
        }
        case "Tag":
          add(ref.from, ref.to, { kind: "tag", text: text.slice(ref.from, ref.to) });
          return false;
        case "CalloutTag": {
          const type = (/^\[!([\w-]+)\]/.exec(text.slice(ref.from, ref.to))?.[1] ?? "note").toLowerCase();
          const rest = text.slice(ref.to, text.indexOf("\n", ref.to) < 0 ? text.length : text.indexOf("\n", ref.to));
          add(ref.from, ref.to, { kind: "callout", type, titled: rest.trim() !== "" });
          return false;
        }
      }
      return true;
    },
  });
  edits.sort((a, b) => a.from - b.from);
  let markdown = "";
  let at = 0;
  for (const edit of edits) {
    if (edit.from < at) continue;
    markdown += text.slice(at, edit.from) + edit.insert;
    at = edit.to;
  }
  return { markdown: markdown + text.slice(at), parts };
}

/** Only the comment and front-matter removal of `preparePrint`, as plain text. */
export function printableMarkdown(text: string): string {
  const cuts: [number, number][] = [];
  plainMarkdownParser.parse(text).iterate({
    enter: (node) => {
      if (!NOT_PRINTED.has(node.name)) return true;
      cuts.push([node.from, node.to]);
      return false;
    },
  });
  let out = "";
  let at = 0;
  for (const [from, to] of cuts) {
    out += text.slice(at, from);
    at = to;
  }
  return out + text.slice(at);
}

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function element(tag: string, className: string, text = ""): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

async function renderPart(part: PrintPart, baseDir: string | null, holder: Node): Promise<Node> {
  switch (part.kind) {
    case "math":
      try {
        const { renderMath } = await import("../editor/lazy");
        // KaTeX escapes its input and runs with `trust: false`: its markup is safe to insert.
        const el = element(part.display ? "div" : "span", part.display ? "np-math-block" : "np-math");
        el.innerHTML = (await renderMath(part.src, part.display)).html;
        return el;
      } catch {
        return document.createTextNode(part.display ? `$$${part.src}$$` : `$${part.src}$`);
      }
    case "mermaid":
      try {
        const { renderMermaid } = await import("../editor/lazy");
        // Mermaid runs with securityLevel "strict", which sanitises the SVG it returns.
        const el = element("div", "np-mermaid");
        el.innerHTML = (await renderMermaid(part.src, false)).html;
        return el;
      } catch {
        const pre = document.createElement("pre");
        pre.appendChild(document.createElement("code")).textContent = part.src;
        return pre;
      }
    case "wikilink":
      return element("span", "np-wikilink", part.text);
    case "embed": {
      const { isImagePath, parseSize } = await import("../editor/livePreview/context");
      if (!isImagePath(part.target)) return element("span", "np-wikilink", part.alias || part.target);
      const image = document.createElement("img");
      const src = safeImageSrc(part.target.split("#")[0], baseDir);
      if (src) image.src = src;
      image.alt = part.target;
      const size = parseSize(part.alias);
      if (size?.width) image.width = size.width;
      if (size?.height) image.height = size.height;
      return image;
    }
    case "tag":
      return element("span", "np-tag", part.text);
    case "callout": {
      const quote = holder.parentElement?.closest("blockquote");
      quote?.classList.add("np-callout", `np-callout-${part.type}`);
      // A callout with its own title shows that title; otherwise its kind, as on screen.
      return part.titled ? document.createTextNode("") : element("strong", "np-callout-title", capitalize(part.type));
    }
  }
}

/** Replaces the placeholders of `preparePrint` with rendered maths, diagrams and the rest. */
export async function renderParts(root: HTMLElement, parts: PrintPart[], baseDir: string | null): Promise<void> {
  if (!parts.length) return;
  const texts: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).data.includes("\uE000")) texts.push(node as Text);
  }
  for (const textNode of texts) {
    const data = textNode.data;
    const pieces: (string | number)[] = [];
    let at = 0;
    for (const match of data.matchAll(TOKEN)) {
      pieces.push(data.slice(at, match.index), Number(match[1]));
      at = (match.index ?? 0) + match[0].length;
    }
    pieces.push(data.slice(at));
    const parent = textNode.parentNode;
    if (!parent) continue;
    // A block (display maths, a diagram) alone in a paragraph replaces that paragraph.
    const lone = pieces.filter((piece) => piece !== "").length === 1 && parent instanceof HTMLParagraphElement && parent.childNodes.length === 1;
    for (const piece of pieces) {
      if (typeof piece === "string") {
        if (piece) parent.insertBefore(document.createTextNode(piece), textNode);
        continue;
      }
      const part = parts[piece];
      const rendered = part ? await renderPart(part, baseDir, textNode) : document.createTextNode("");
      const block = part && ((part.kind === "math" && part.display) || part.kind === "mermaid");
      if (block && lone) {
        parent.parentNode?.replaceChild(rendered, parent);
        break;
      }
      parent.insertBefore(rendered, textNode);
    }
    if (textNode.parentNode) textNode.remove();
  }
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
    const baseDir = tab.path ? dirOf(tab.path) : null;
    const { markdown, parts } = preparePrint(text);
    const html = marked.parse(markdown, { async: false, gfm: true }) as string;
    root.appendChild(sanitizeHtml(html, baseDir));
    await renderParts(root, parts, baseDir);
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
