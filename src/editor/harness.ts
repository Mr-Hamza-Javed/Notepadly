// Manual test page: open /src/editor/harness.html under the Vite dev server.
// Nothing in the app references this file, so it never reaches the production build.
import { EditorView } from "@codemirror/view";
import { TreeFragment } from "@lezer/common";
import { notepadlyParser, plainMarkdownParser } from "./markdown";
import "../styles/tokens.css";
import type { CursorInfo, EditorConfig, EditorHost, FormatContext, FormatMode } from "./api";
import { engine } from "./index";

const SAMPLE = `---
title: Notepadly sample
tags: [demo, test]
---

# Heading one
## Heading two
### Heading three
Setext heading
==============

Plain, **bold**, *italic*, ***bold italic***, ~~strike~~, ==highlight==, \`inline code\`, H<sub>2</sub>O, x<sup>2</sup>.

Links: [inline](https://example.com), <https://autolink.example>, https://bare.example.com, [ref link][site], [[Sibling note]], [[Sibling note|with alias]].

[site]: https://example.org "Reference"

Images: ![Pixel|64](data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=) and embed ![[missing.png|120]] and note embed ![[Other note]].

> A blockquote
> > nested once
> > > nested twice

> [!note] A note callout
> Body of the note.

> [!warning]
> Warning with a default title.

> [!tip]- Folded tip
> Hidden body until unfolded.

- Bullet one
    - Nested bullet
        - Deeper bullet
- [ ] Open task
- [x] Finished task

1. First
2. Second
3. Third

---

\`\`\`typescript
const answer: number = 42; // lazy grammar
function greet(name: string) { return \`hi \${name}\`; }
\`\`\`

    indented code block

| Left | Centre | Right |
| :--- | :----: | ----: |
| **a** | \`b\` | c |
| d | [link](https://example.com) | ~~f~~ |

Inline math $E = mc^2$ and a price of $5 and $6 stays text.

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

\`\`\`mermaid
graph TD
  A[Start] --> B{Choice}
  B -->|Yes| C[Done]
  B -->|No| A
\`\`\`

Footnote reference[^1] in a sentence.

[^1]: The footnote definition.

%%inline comment%% then text, with #tag and #nested/tag pills, and \\*escaped\\* stars.

<span class="x">inline html</span>

%%
block comment
%%

یہ اردو کی ایک سطر ہے جو دائیں سے بائیں لکھی جاتی ہے۔

Mixed line with English then اردو الفاظ then English.
`;

const STRESS_CHUNK = `## Section

Some **bold** text, some *italic* text, a [link](https://example.com), and \`code\` to decorate.

- list item one
- [ ] list item two

| a | b |
| - | - |
| 1 | 2 |

`;

function stressDocument(): string {
  const target = 10 * 1024 * 1024;
  return STRESS_CHUNK.repeat(Math.ceil(target / STRESS_CHUNK.length));
}

const status = document.getElementById("status") as HTMLOutputElement;
const events = { dirty: 0, docChange: 0, cursor: 0, nearEnd: 0, links: [] as string[], zoom: [] as number[] };
let lastCursor: CursorInfo | null = null;
let lastContext: FormatContext | null = null;
let isDirty = false;

function render(): void {
  const c = lastCursor;
  status.textContent = c
    ? `Ln ${c.line}, Col ${c.col} | ${c.chars} chars | sel ${c.selected} | ${isDirty ? "dirty" : "clean"} | ${lastContext?.block ?? ""}`
    : "";
}

const host: EditorHost = {
  onDirtyChange(_id, dirty) {
    isDirty = dirty;
    events.dirty++;
    render();
  },
  onDocChange() {
    events.docChange++;
  },
  onCursor(_id, info) {
    lastCursor = info;
    events.cursor++;
    render();
  },
  onFormatContext(_id, context) {
    lastContext = context;
    render();
  },
  onNearEnd() {
    events.nearEnd++;
  },
  onZoomDelta(delta) {
    events.zoom.push(delta);
    config.zoom = Math.min(500, Math.max(10, config.zoom + delta));
    engine.setConfig({ zoom: config.zoom });
  },
  openLink(href) {
    events.links.push(href);
  },
  baseDir: () => null,
};

const config: EditorConfig = {
  wordWrap: true,
  zoom: 100,
  fontFamily: '"Segoe UI Variable Text", "Segoe UI", sans-serif',
  fontWeight: 500,
  fontSizePt: 11,
  spellcheck: false,
  autocorrect: false,
};

engine.mount(document.getElementById("host") as HTMLElement, host, config);

const view = () => EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement) as EditorView;

let serial = 0;
let currentTab = "";

function open(text: string, mode: FormatMode = "formatted"): void {
  const previous = currentTab;
  currentTab = `tab-${++serial}`;
  engine.createDoc(currentTab, text, mode);
  engine.activate(currentTab);
  if (previous) engine.dropDoc(previous);
  engine.focus();
}

interface KeystrokeReport {
  samples: number;
  dispatchMs: { median: number; max: number };
  /** Dispatch plus CodeMirror's measure pass and a forced layout: the main-thread cost of a keystroke. */
  workMs: { median: number; max: number };
  /** Frame-locked, so its floor is one display frame. */
  toPaintMs: { median: number; max: number };
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

function summarize(values: number[]): { median: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { median: round(sorted[Math.floor(sorted.length / 2)]), max: round(sorted[sorted.length - 1]) };
}

/** Times typed characters mid-document, from dispatch to the frame that paints them. */
async function measureKeystrokes(samples = 40, position?: number): Promise<KeystrokeReport> {
  const editor = view();
  const anchor = position ?? Math.floor(editor.state.doc.length / 2);
  editor.dispatch({ selection: { anchor }, scrollIntoView: true });
  await nextFrame();
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const dispatchTimes: number[] = [];
  const workTimes: number[] = [];
  const paintTimes: number[] = [];
  const measurable = editor as unknown as { measure(flush?: boolean): void };
  for (let i = 0; i < samples; i++) {
    await nextFrame();
    const start = performance.now();
    editor.dispatch(editor.state.replaceSelection("x"), { userEvent: "input.type" });
    dispatchTimes.push(performance.now() - start);
    measurable.measure();
    void editor.contentDOM.offsetHeight;
    workTimes.push(performance.now() - start);
    await nextFrame();
    paintTimes.push(performance.now() - start);
  }
  return {
    samples,
    dispatchMs: summarize(dispatchTimes),
    workMs: summarize(workTimes),
    toPaintMs: summarize(paintTimes),
  };
}

const actions: Record<string, () => void> = {
  sample: () => open(SAMPLE),
  stress: () => open(stressDocument()),
  formatted: () => engine.setMode(currentTab, "formatted"),
  syntax: () => engine.setMode(currentTab, "syntax"),
  plain: () => engine.setMode(currentTab, "plain"),
  theme: () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  },
  wrap: () => {
    config.wordWrap = !config.wordWrap;
    engine.setConfig({ wordWrap: config.wordWrap });
  },
  measure: () => {
    void measureKeystrokes().then((report) => {
      status.textContent = JSON.stringify(report);
    });
  },
};

document.getElementById("bar")?.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).dataset.action;
  if (action) actions[action]?.();
});

/**
 * Differential test for the prefix-reuse parser: applies chained random edits and checks
 * each incremental tree against a fresh full parse of the same text.
 */
function verifyIncremental(edits = 300, seed = 7): { edits: number; mismatches: number; reused: number; first?: string } {
  let random = seed;
  const next = (n: number) => {
    random = (random * 1103515245 + 12345) & 0x7fffffff;
    return random % n;
  };
  const inserts = ["x", "\n", "```\n", "> ", "- ", "\n\n", "$$\n", "| a | b |\n", "# ", "  ", "---\n", "1. ", "%%\n", "<div>\n", "[^1]: n\n"];
  let text = SAMPLE.repeat(220);
  let tree = notepadlyParser.parse(text);
  let fragments = TreeFragment.addTree(tree);
  let mismatches = 0;
  let reused = 0;
  let first: string | undefined;
  for (let i = 0; i < edits; i++) {
    const from = next(text.length);
    const remove = next(4) === 0 ? Math.min(text.length - from, next(40)) : 0;
    const insert = next(3) === 0 ? "" : inserts[next(inserts.length)];
    text = text.slice(0, from) + insert + text.slice(from + remove);
    fragments = TreeFragment.applyChanges(fragments, [
      { fromA: from, toA: from + remove, fromB: from, toB: from + insert.length },
    ]);
    if (fragments.some((f) => f.from === 0 && f.to > 34816)) reused++;
    tree = notepadlyParser.parse(text, fragments);
    fragments = TreeFragment.addTree(tree, fragments);
    if (tree.toString() !== plainMarkdownParser.parse(text).toString()) {
      mismatches++;
      first ??= `edit ${i} at ${from}: ${JSON.stringify(insert)} -${remove}`;
    }
  }
  return { edits, mismatches, reused, first };
}

Object.assign(window, {
  notepadly: { engine, view, open, measureKeystrokes, verifyIncremental, events, actions, stressDocument, currentTab: () => currentTab },
});

open(SAMPLE);
