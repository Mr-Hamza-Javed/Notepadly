// Inline and line-level live preview. Decorates only the visible ranges.
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { CALLOUT_LINE, calloutFolded, toggleCalloutFold } from "./block";
import {
  isImagePath,
  parseSize,
  previewContext,
  resolveHref,
  resolveWikiTarget,
} from "./context";
import {
  BulletWidget,
  CalloutTitleWidget,
  CheckboxWidget,
  CodeLabelWidget,
  EmbedPillWidget,
  ImageWidget,
  MathWidget,
} from "./widgets";

const hide = Decoration.replace({});

const markCache = new Map<string, Decoration>();
function mark(className: string): Decoration {
  let deco = markCache.get(className);
  if (!deco) {
    deco = Decoration.mark({ class: className });
    markCache.set(className, deco);
  }
  return deco;
}

const lineCache = new Map<string, Decoration>();
function lineDeco(className: string): Decoration {
  let deco = lineCache.get(className);
  if (!deco) {
    deco = Decoration.line({ class: className });
    lineCache.set(className, deco);
  }
  return deco;
}

const SPAN_STYLES: Record<string, string> = {
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  Strikethrough: "cm-md-strike",
  Highlight: "cm-md-highlight",
  InlineCode: "cm-md-code",
};

const SPAN_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "HighlightMark"]);

/** Attribute-free inline HTML tags rendered in place; anything else shows as styled source. */
const INLINE_HTML_TAG = /^<(\/?)(sub|sup|kbd|u|ins|mark|b|strong|i|em|s|del|strike|small)>$/i;
/** Tag to the `cm-md-*` class it renders with; synonyms share one class. */
const HTML_TAG_CLASS: Record<string, string> = {
  sub: "sub",
  sup: "sup",
  kbd: "kbd",
  u: "u",
  ins: "u",
  mark: "highlight",
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  s: "strike",
  del: "strike",
  strike: "strike",
  small: "small",
};

function onToggleCallout(view: EditorView, pos: number): void {
  view.dispatch({ effects: toggleCalloutFold.of(view.state.doc.lineAt(pos).from) });
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

class Builder {
  readonly ranges: Range<Decoration>[] = [];
  private readonly lineClasses = new Map<number, string>();
  private readonly quoteDepth = new Map<number, number>();
  private readonly calloutTitles = new Set<number>();
  private readonly openHtml: { tag: string; from: number; to: number }[] = [];
  private depth = 0;
  private readonly doc;

  constructor(
    private readonly state: EditorState,
    private readonly visible: { from: number; to: number },
  ) {
    this.doc = state.doc;
  }

  private touches(from: number, to: number): boolean {
    return this.state.selection.ranges.some((range) => range.from <= to && range.to >= from);
  }

  private lineTouched(pos: number): boolean {
    const line = this.doc.lineAt(pos);
    return this.touches(line.from, line.to);
  }

  private addLine(from: number, className: string): void {
    const existing = this.lineClasses.get(from);
    this.lineClasses.set(from, existing ? `${existing} ${className}` : className);
  }

  /** Runs `fn` for the lines of a node that fall inside the visible range. */
  private eachVisibleLine(from: number, to: number, fn: (lineFrom: number, text: string) => void): void {
    const start = this.doc.lineAt(Math.max(from, this.visible.from));
    const end = this.doc.lineAt(Math.min(to, this.visible.to));
    for (let number = start.number; number <= end.number; number++) {
      const line = this.doc.line(number);
      fn(line.from, line.text);
    }
  }

  private dim(from: number, to: number): void {
    if (to > from) this.ranges.push(mark("cm-md-mark").range(from, to));
  }

  private hideRange(from: number, to: number): void {
    if (to > from) this.ranges.push(hide.range(from, to));
  }

  private hideOrDim(from: number, to: number, reveal: boolean): void {
    if (reveal) this.dim(from, to);
    else this.hideRange(from, to);
  }

  private spaceAfter(pos: number): number {
    return this.doc.sliceString(pos, pos + 1) === " " ? pos + 1 : pos;
  }

  enter(ref: SyntaxNodeRef): boolean {
    const { name, from, to } = ref;
    const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
    if (heading) {
      const className = `cm-md-h cm-md-h${heading[2]}`;
      this.eachVisibleLine(from, to, (lineFrom) => this.addLine(lineFrom, className));
      return true;
    }
    const spanStyle = SPAN_STYLES[name];
    if (spanStyle) {
      this.ranges.push(mark(spanStyle).range(from, to));
      return true;
    }
    if (SPAN_MARKS.has(name)) {
      const parent = ref.node.parent;
      this.hideOrDim(from, to, parent ? this.touches(parent.from, parent.to) : true);
      return false;
    }

    switch (name) {
      case "HeaderMark": {
        const reveal = this.lineTouched(from);
        const line = this.doc.lineAt(from);
        if (from === line.from || /^\s*$/.test(this.doc.sliceString(line.from, from))) {
          this.hideOrDim(from, reveal ? to : this.spaceAfter(to), reveal);
        } else {
          let start = from;
          while (start > line.from && this.doc.sliceString(start - 1, start) === " ") start--;
          this.hideOrDim(reveal ? from : start, to, reveal);
        }
        return false;
      }
      case "Blockquote":
        return this.blockquote(ref);
      case "QuoteMark": {
        const line = this.doc.lineAt(from);
        if (this.calloutTitles.has(line.from) && !this.touches(line.from, line.to)) return false;
        const reveal = this.touches(line.from, line.to);
        this.hideOrDim(from, reveal ? to : this.spaceAfter(to), reveal);
        return false;
      }
      case "CalloutTag":
        if (this.lineTouched(from)) this.dim(from, to);
        return false;
      case "ListMark":
        return this.listMark(ref);
      case "TaskMarker":
        // Reached only on a revealed line; rendered lines are replaced from ListMark.
        this.dim(from, to);
        return false;
      case "Task":
        if (/^\[[xX]\]/.test(this.doc.sliceString(from, from + 3))) {
          this.ranges.push(mark("cm-md-task-done").range(from, to));
        }
        return true;
      case "CodeMark": {
        const parent = ref.node.parent;
        this.hideOrDim(from, to, parent ? this.touches(parent.from, parent.to) : true);
        return false;
      }
      case "FencedCode":
        this.fencedCode(ref);
        return false;
      case "CodeBlock":
        this.eachVisibleLine(from, to, (lineFrom) => this.addLine(lineFrom, "cm-md-codeblock"));
        return false;
      case "Link":
        return this.link(ref);
      case "Autolink": {
        const reveal = this.touches(from, to);
        for (const child of ref.node.getChildren("LinkMark")) this.hideOrDim(child.from, child.to, reveal);
        return true;
      }
      case "URL": {
        const parentName = ref.node.parent?.name;
        if (parentName !== "Link" && parentName !== "Image" && parentName !== "LinkReference") {
          this.ranges.push(mark("cm-md-link").range(from, to));
        }
        return false;
      }
      case "LinkReference":
        this.ranges.push(mark("cm-md-linkdef").range(from, to));
        return false;
      case "Image":
        this.image(ref);
        return false;
      case "WikiLink":
        this.wikiLink(ref);
        return false;
      case "Embed":
        this.embed(ref);
        return false;
      case "Tag":
        this.ranges.push(mark("cm-md-tag").range(from, to));
        return false;
      case "InlineMath":
        this.inlineMath(ref);
        return false;
      case "BlockMath":
        this.eachVisibleLine(from, to, (lineFrom) => this.addLine(lineFrom, "cm-md-math-raw"));
        return false;
      case "Table":
        this.eachVisibleLine(from, to, (lineFrom) => this.addLine(lineFrom, "cm-md-table-raw"));
        return false;
      case "InlineComment":
        this.ranges.push(mark("cm-md-comment").range(from, to));
        return false;
      case "CommentBlock":
        this.eachVisibleLine(from, to, (lineFrom) => this.addLine(lineFrom, "cm-md-comment"));
        return false;
      case "Frontmatter":
        this.frontmatter(ref);
        return false;
      case "FootnoteRef":
        this.footnoteRef(ref);
        return false;
      case "FootnoteLabel":
        this.ranges.push(mark("cm-md-footnote-label").range(from, to));
        return false;
      case "Escape": {
        if (!this.touches(from, to)) this.hideRange(from, from + 1);
        return false;
      }
      case "HTMLTag":
        this.htmlTag(ref);
        return false;
      case "HTMLBlock":
      case "CommentBlockHTML":
        this.eachVisibleLine(from, to, (lineFrom) => this.addLine(lineFrom, "cm-md-html-block"));
        return false;
      case "HorizontalRule": {
        // Top-level rules are block widgets; a nested one stays styled source.
        if (ref.node.parent?.name !== "Document") this.dim(from, to);
        return false;
      }
    }
    return true;
  }

  leave(ref: SyntaxNodeRef): void {
    if (ref.name === "Blockquote") this.depth--;
  }

  private blockquote(ref: SyntaxNodeRef): boolean {
    this.depth++;
    const depth = this.depth;
    this.eachVisibleLine(ref.from, ref.to, (lineFrom) => {
      this.quoteDepth.set(lineFrom, Math.max(depth, this.quoteDepth.get(lineFrom) ?? 0));
    });
    if (depth > 1) return true;

    const first = this.doc.lineAt(ref.from);
    const match = CALLOUT_LINE.exec(first.text);
    if (!match) return true;

    const kind = match[2].toLowerCase();
    this.eachVisibleLine(ref.from, ref.to, (lineFrom) =>
      this.addLine(lineFrom, `cm-md-callout cm-md-callout-${kind}`),
    );
    // The bottom padding goes on the last visible line of the box: the title when folded.
    const folded = match[3] !== "" && calloutFolded(this.state, first.from, match[3]);
    const last = folded ? first : this.doc.lineAt(Math.max(ref.from, ref.to - (this.doc.sliceString(ref.to - 1, ref.to) === "\n" ? 1 : 0)));
    if (last.from >= this.visible.from && last.from <= this.visible.to) this.addLine(last.from, "cm-md-callout-last");
    if (first.from < this.visible.from || first.from > this.visible.to) return true;
    this.addLine(first.from, "cm-md-callout-title");
    this.calloutTitles.add(first.from);
    if (!this.touches(first.from, first.to)) {
      const titleStart = first.to - match[4].length;
      this.ranges.push(
        Decoration.replace({
          widget: new CalloutTitleWidget(
            kind,
            match[4] ? "" : capitalize(kind),
            match[3] !== "",
            calloutFolded(this.state, first.from, match[3]),
            onToggleCallout,
          ),
        }).range(first.from, titleStart),
      );
    }
    return true;
  }

  private listMark(ref: SyntaxNodeRef): boolean {
    const { from, to } = ref;
    const node = ref.node;
    const item = node.parent;
    const list = item?.parent;
    const reveal = this.lineTouched(from);
    const task = node.nextSibling?.name === "Task" ? node.nextSibling : null;

    if (reveal) {
      this.ranges.push(mark("cm-md-listmark").range(from, to));
      return false;
    }
    if (task) {
      const marker = task.firstChild;
      if (marker?.name === "TaskMarker") {
        const checked = /[xX]/.test(this.doc.sliceString(marker.from, marker.to));
        this.ranges.push(
          Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, marker.to),
        );
        return false;
      }
    }
    if (list?.name === "BulletList") {
      let depth = 0;
      for (let parent = list.parent; parent; parent = parent.parent) {
        if (parent.name === "BulletList" || parent.name === "OrderedList") depth++;
      }
      this.ranges.push(Decoration.replace({ widget: new BulletWidget(depth) }).range(from, to));
    } else {
      this.ranges.push(mark("cm-md-listmark").range(from, to));
    }
    return false;
  }

  private fencedCode(ref: SyntaxNodeRef): void {
    const { from, to } = ref;
    const first = this.doc.lineAt(from);
    const last = this.doc.lineAt(to);
    const node = ref.node;
    const infoNode = node.getChild("CodeInfo");
    const info = infoNode ? this.doc.sliceString(infoNode.from, infoNode.to) : "";
    const isMermaid = info.toLowerCase() === "mermaid";

    this.eachVisibleLine(from, to, (lineFrom) => {
      let className = "cm-md-codeblock";
      if (lineFrom === first.from) className += " cm-md-codeblock-first";
      if (lineFrom === last.from) className += " cm-md-codeblock-last";
      this.addLine(lineFrom, className);
    });

    // A revealed Mermaid block is raw source, fences included.
    const fenceLine = (line: { from: number; to: number }, label: string) => {
      if (line.from < this.visible.from || line.from > this.visible.to) return;
      if (isMermaid || this.touches(line.from, line.to)) {
        this.dim(line.from, line.to);
      } else if (line.to > line.from) {
        const widget = label ? new CodeLabelWidget(label) : undefined;
        this.ranges.push(Decoration.replace(widget ? { widget } : {}).range(line.from, line.to));
      }
    };
    fenceLine(first, info);
    if (last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text)) fenceLine(last, "");
  }

  private link(ref: SyntaxNodeRef): boolean {
    const { from, to } = ref;
    const marks = ref.node.getChildren("LinkMark");
    if (marks.length < 2) return true;
    const reveal = this.touches(from, to);
    const labelEnd = marks[1].from;
    if (labelEnd > marks[0].to) this.ranges.push(mark("cm-md-link").range(marks[0].to, labelEnd));
    this.hideOrDim(from, marks[0].to, reveal);
    this.hideOrDim(labelEnd, to, reveal);
    return true;
  }

  private image(ref: SyntaxNodeRef): void {
    const { from, to } = ref;
    if (this.touches(from, to)) {
      this.dim(from, to);
      return;
    }
    const node = ref.node;
    const marks = node.getChildren("LinkMark");
    const url = node.getChild("URL");
    if (marks.length < 2 || !url) {
      this.dim(from, to);
      return;
    }
    const altText = this.doc.sliceString(marks[0].to, marks[1].from);
    const bar = altText.lastIndexOf("|");
    const size = bar >= 0 ? parseSize(altText.slice(bar + 1)) : null;
    const alt = size ? altText.slice(0, bar) : altText;
    const widget = new ImageWidget(this.doc.sliceString(url.from, url.to), alt, size?.width, size?.height);
    this.ranges.push(Decoration.replace({ widget }).range(from, to));
  }

  private wikiLink(ref: SyntaxNodeRef): void {
    const { from, to } = ref;
    const node = ref.node;
    const reveal = this.touches(from, to);
    const target = node.getChild("WikiTarget");
    const alias = node.getChild("WikiAlias");
    const shown = alias ?? target;
    if (!shown) return;
    this.ranges.push(mark("cm-md-link cm-md-wikilink").range(shown.from, shown.to));
    this.hideOrDim(from, shown.from, reveal);
    this.hideOrDim(shown.to, to, reveal);
  }

  private embed(ref: SyntaxNodeRef): void {
    const { from, to } = ref;
    if (this.touches(from, to)) {
      this.dim(from, to);
      return;
    }
    const node = ref.node;
    const targetNode = node.getChild("WikiTarget");
    if (!targetNode) return;
    const target = this.doc.sliceString(targetNode.from, targetNode.to).trim();
    const aliasNode = node.getChild("WikiAlias");
    const alias = aliasNode ? this.doc.sliceString(aliasNode.from, aliasNode.to) : "";
    if (isImagePath(target)) {
      const size = parseSize(alias);
      const widget = new ImageWidget(target, size ? target : alias || target, size?.width, size?.height);
      this.ranges.push(Decoration.replace({ widget }).range(from, to));
    } else {
      this.ranges.push(
        Decoration.replace({ widget: new EmbedPillWidget(alias || target) }).range(from, to),
      );
    }
  }

  private inlineMath(ref: SyntaxNodeRef): void {
    const { from, to } = ref;
    const marks = ref.node.getChildren("MathMark");
    if (marks.length !== 2 || this.touches(from, to)) {
      this.ranges.push(mark("cm-md-math-source").range(from, to));
      return;
    }
    const text = this.doc.sliceString(marks[0].to, marks[1].from);
    const widget = new MathWidget(text, false, marks[0].to - from);
    this.ranges.push(Decoration.replace({ widget }).range(from, to));
  }

  private frontmatter(ref: SyntaxNodeRef): void {
    this.eachVisibleLine(ref.from, ref.to, (lineFrom, text) => {
      this.addLine(lineFrom, "cm-md-frontmatter");
      const key = /^[\w"'.-]+(?=\s*:)/.exec(text);
      if (key) this.ranges.push(mark("cm-md-fm-key").range(lineFrom, lineFrom + key[0].length));
    });
  }

  private footnoteRef(ref: SyntaxNodeRef): void {
    const { from, to } = ref;
    const reveal = this.touches(from, to);
    const id = ref.node.getChild("FootnoteId");
    if (!id) return;
    this.ranges.push(mark("cm-md-footnote").range(id.from, id.to));
    this.hideOrDim(from, id.from, reveal);
    this.hideOrDim(id.to, to, reveal);
  }

  private htmlTag(ref: SyntaxNodeRef): void {
    const { from, to } = ref;
    const text = this.doc.sliceString(from, to);
    const match = INLINE_HTML_TAG.exec(text);
    if (!match) {
      this.ranges.push(mark("cm-md-html").range(from, to));
      return;
    }
    const tag = HTML_TAG_CLASS[match[2].toLowerCase()];
    if (!match[1]) {
      this.openHtml.push({ tag, from, to });
      return;
    }
    const open = this.openHtml.pop();
    if (!open || open.tag !== tag) {
      this.ranges.push(mark("cm-md-html").range(from, to));
      return;
    }
    const reveal = this.touches(open.from, to);
    if (to > open.to && from > open.to) this.ranges.push(mark(`cm-md-${tag}`).range(open.to, from));
    this.hideOrDim(open.from, open.to, reveal);
    this.hideOrDim(from, to, reveal);
  }

  /** Line decorations are emitted last, once every class for a line is known. */
  finish(): void {
    for (const [from, depth] of this.quoteDepth) {
      this.addLine(from, `cm-md-quote cm-md-q${Math.min(depth, 4)}`);
    }
    for (const [from, className] of this.lineClasses) {
      this.ranges.push(lineDeco(className).range(from));
    }
    this.lineClasses.clear();
    this.quoteDepth.clear();
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const tree = syntaxTree(state);
  const all: Range<Decoration>[] = [];
  for (const visible of view.visibleRanges) {
    const builder = new Builder(state, visible);
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter: (ref) => builder.enter(ref),
      leave: (ref) => builder.leave(ref),
    });
    builder.finish();
    for (const range of builder.ranges) all.push(range);
  }
  return Decoration.set(all, true);
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      const foldToggled = update.transactions.some((tr) => tr.effects.some((e) => e.is(toggleCalloutFold)));
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        foldToggled ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function ancestor(node: SyntaxNode | null, names: readonly string[]): SyntaxNode | null {
  for (let current = node; current; current = current.parent) {
    if (names.includes(current.name)) return current;
  }
  return null;
}

/** Looks up a reference definition. Runs on a click only, so a full-tree walk is fine. */
function findReference(state: EditorState, label: string): string | null {
  const wanted = label.toLowerCase();
  let href: string | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (href !== null) return false;
      if (node.name !== "LinkReference") return node.name === "Document";
      const labelNode = node.node.getChild("LinkLabel");
      const url = node.node.getChild("URL");
      if (labelNode && url) {
        const text = state.sliceDoc(labelNode.from + 1, labelNode.to - 1).toLowerCase();
        if (text === wanted) href = state.sliceDoc(url.from, url.to);
      }
      return false;
    },
  });
  return href;
}

function linkHrefAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state);
  const names = ["Link", "Image", "Autolink", "URL", "WikiLink", "Embed"];
  const node = ancestor(tree.resolveInner(pos, 1), names) ?? ancestor(tree.resolveInner(pos, -1), names);
  if (!node) return null;
  if (node.name === "URL") return resolveHref(state.sliceDoc(node.from, node.to));
  if (node.name === "WikiLink" || node.name === "Embed") {
    const target = node.getChild("WikiTarget");
    return target ? resolveWikiTarget(state.sliceDoc(target.from, target.to)) : null;
  }
  const url = node.getChild("URL");
  if (url) return resolveHref(state.sliceDoc(url.from, url.to));
  const label = node.getChild("LinkLabel");
  const marks = node.getChildren("LinkMark");
  let key = label ? state.sliceDoc(label.from + 1, label.to - 1) : "";
  if (!key && marks.length >= 2) key = state.sliceDoc(marks[0].to, marks[1].from);
  const found = key ? findReference(state, key) : null;
  return found ? resolveHref(found) : null;
}

function jumpToFootnote(view: EditorView, pos: number): boolean {
  const { state } = view;
  const tree = syntaxTree(state);
  const ref = ancestor(tree.resolveInner(pos, 1), ["FootnoteRef"]) ?? ancestor(tree.resolveInner(pos, -1), ["FootnoteRef"]);
  const id = ref?.getChild("FootnoteId");
  if (!id) return false;
  const label = `[^${state.sliceDoc(id.from, id.to)}]:`;
  let target = -1;
  tree.iterate({
    enter: (node) => {
      if (target >= 0) return false;
      if (node.name === "FootnoteDefinition" && state.sliceDoc(node.from, node.from + label.length) === label) {
        target = node.from;
      }
      return node.name === "Document";
    },
  });
  if (target < 0) return false;
  view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
  return true;
}

const ctrlClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!event.ctrlKey || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const href = linkHrefAt(view.state, pos);
    if (href) {
      event.preventDefault();
      previewContext.openLink(href);
      return true;
    }
    if (jumpToFootnote(view, pos)) {
      event.preventDefault();
      return true;
    }
    return false;
  },
});

export const inlinePreview = [inlinePlugin, ctrlClick];
