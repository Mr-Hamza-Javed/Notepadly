// Dynamically imported renderers and their small render caches.
import type { default as KatexApi } from "katex";

export class LruCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

export interface RenderedHtml {
  html: string;
  /** Last measured height in CSS px; 0 until measured. */
  height: number;
}

const mathCache = new LruCache<RenderedHtml>(300);
const mermaidCache = new LruCache<RenderedHtml>(40);

let katexLoading: Promise<typeof KatexApi> | null = null;

function loadKatex(): Promise<typeof KatexApi> {
  katexLoading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([mod]) => mod.default,
  );
  return katexLoading;
}

const mathKey = (src: string, display: boolean) => (display ? "D" : "I") + src;

export function cachedMath(src: string, display: boolean): RenderedHtml | undefined {
  return mathCache.get(mathKey(src, display));
}

export async function renderMath(src: string, display: boolean): Promise<RenderedHtml> {
  const katex = await loadKatex();
  const key = mathKey(src, display);
  let entry = mathCache.get(key);
  if (!entry) {
    // KaTeX output inherits currentColor, so it follows the theme without re-rendering.
    const html = katex.renderToString(src, {
      displayMode: display,
      throwOnError: false,
      output: "html",
      strict: "ignore",
    });
    entry = { html, height: 0 };
    mathCache.set(key, entry);
  }
  return entry;
}

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidLoading: Promise<MermaidApi> | null = null;
let mermaidQueue: Promise<unknown> = Promise.resolve();
let mermaidSerial = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidLoading ??= import("mermaid").then((mod) => mod.default);
  return mermaidLoading;
}

const mermaidKey = (src: string, dark: boolean) => (dark ? "D" : "L") + src;

export function cachedMermaid(src: string, dark: boolean): RenderedHtml | undefined {
  return mermaidCache.get(mermaidKey(src, dark));
}

/** Mermaid keeps global config and DOM scratch space, so renders run one at a time. */
export function renderMermaid(src: string, dark: boolean): Promise<RenderedHtml> {
  const job = mermaidQueue.then(async () => {
    const key = mermaidKey(src, dark);
    const hit = mermaidCache.get(key);
    if (hit) return hit;
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      suppressErrorRendering: true,
    });
    const { svg } = await mermaid.render(`notepadly-mermaid-${++mermaidSerial}`, src);
    const entry: RenderedHtml = { html: svg, height: 0 };
    mermaidCache.set(key, entry);
    return entry;
  });
  mermaidQueue = job.catch(() => undefined);
  return job;
}
