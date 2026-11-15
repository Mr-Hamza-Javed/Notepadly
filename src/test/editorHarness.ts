// Real CodeMirror views for tests: a mounted engine, or a bare view with the markdown language.
import "./dom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { engine } from "../editor";
import type { CursorInfo, EditorConfig, EditorHost, FormatContext } from "../editor/api";
import { markdownSupport } from "../editor/markdown";

export const TEST_CONFIG: EditorConfig = {
  wordWrap: true,
  zoom: 100,
  fontFamily: "",
  fontWeight: 400,
  fontSizePt: 11,
  spellcheck: false,
  autocorrect: false,
};

export interface HostLog {
  dirty: [string, boolean][];
  docChanges: string[];
  cursor: [string, CursorInfo][];
  format: [string, FormatContext][];
  nearEnd: string[];
  zoom: number[];
  links: string[];
}

/** Mounts the app's single engine on a fresh element with a recording host. */
export function mountEngine(overrides: Partial<EditorHost> = {}): { host: EditorHost; log: HostLog; parent: HTMLElement } {
  document.body.innerHTML = "";
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const log: HostLog = { dirty: [], docChanges: [], cursor: [], format: [], nearEnd: [], zoom: [], links: [] };
  const host: EditorHost = {
    onDirtyChange: (id, dirty) => log.dirty.push([id, dirty]),
    onDocChange: (id) => log.docChanges.push(id),
    onCursor: (id, info) => log.cursor.push([id, info]),
    onFormatContext: (id, ctx) => log.format.push([id, ctx]),
    onNearEnd: (id) => log.nearEnd.push(id),
    onZoomDelta: (delta) => log.zoom.push(delta),
    openLink: (href) => log.links.push(href),
    baseDir: () => null,
    ...overrides,
  };
  engine.mount(parent, host, TEST_CONFIG);
  return { host, log, parent };
}

/**
 * A bare EditorView with the app's markdown language. `|` in the text marks the
 * cursor; two of them mark a selection (anchor first).
 */
export function markdownView(textWithCursor: string): EditorView {
  const marks: number[] = [];
  let text = "";
  for (const ch of textWithCursor) {
    if (ch === "|" && marks.length < 2) {
      marks.push(text.length);
    } else {
      text += ch;
    }
  }
  const selection =
    marks.length === 0
      ? EditorSelection.cursor(0)
      : marks.length === 1
        ? EditorSelection.cursor(marks[0])
        : EditorSelection.range(marks[0], marks[1]);
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, selection, extensions: [markdownSupport, history()] }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

/** A view whose text may itself contain `|` (tables): pass the selection explicitly. */
export function markdownViewAt(text: string, anchor: number, head = anchor): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, selection: EditorSelection.range(anchor, head), extensions: [markdownSupport, history()] }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

/** Document text with the selection drawn back in as `|` markers. */
export function show(view: EditorView): string {
  const { doc, selection } = view.state;
  const { anchor, head } = selection.main;
  const text = doc.toString();
  if (anchor === head) return text.slice(0, head) + "|" + text.slice(head);
  const [a, b] = [Math.min(anchor, head), Math.max(anchor, head)];
  return text.slice(0, a) + "|" + text.slice(a, b) + "|" + text.slice(b);
}

/** Lets requestAnimationFrame callbacks (cursor reports) run. */
export const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 40));
