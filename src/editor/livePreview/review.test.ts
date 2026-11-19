// @vitest-environment jsdom
// Live preview edge cases found in review (BUGS.md PREV-*).
import "../../test/dom";
import { history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { markdownSupport } from "../markdown";
import { blockField, blockPreview } from "./block";
import { inlinePreview } from "./inline";
import { MermaidWidget } from "./widgets";

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock("../theme", async (original) => ({
  ...(await original<typeof import("../theme")>()),
  isDarkTheme: () => theme.dark,
}));

const extensions = [markdownSupport, history(), blockPreview, inlinePreview];

function makeState(doc: string, cursor = doc.length): EditorState {
  const state = EditorState.create({ doc, selection: { anchor: cursor }, extensions });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function preview(doc: string, cursor = doc.length): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: makeState(doc, cursor) });
  // A no-op transaction lets the block field rescan with the full tree.
  view.dispatch({});
  return view;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mermaidThemes(view: EditorView): boolean[] {
  const out: boolean[] = [];
  view.state.field(blockField).shown.between(0, view.state.doc.length, (_from, _to, deco) => {
    const widget = deco.spec.widget;
    if (widget instanceof MermaidWidget) out.push(widget.dark);
  });
  return out;
}

describe("theme changes", () => {
  it("PREV-1: a tab that was in the background when the theme changed shows its diagram in the new theme", async () => {
    theme.dark = false;
    const diagram = "text\n\n```mermaid\ngraph TD; A-->B\n```\n\nend";
    const view = preview("first tab");
    // The second tab's state was built (and its blocks scanned) in the light theme.
    let background = makeState(diagram, 0);
    background = background.update({}).state;
    expect(background.field(blockField).shown.size).toBe(1);

    // The theme changes while the first tab is shown; the engine rebuilds only the view's state.
    theme.dark = true;
    // Switching tabs puts the background state in the view.
    view.setState(background);
    await tick();
    expect(mermaidThemes(view)).toEqual([true]);
    theme.dark = false;
  });
});
