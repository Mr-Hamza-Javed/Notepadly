// Lezer Markdown configuration: GFM plus Notepadly's inline and block extensions.
// Built directly on @lezer/markdown (not @codemirror/lang-markdown) so the HTML, CSS
// and JavaScript grammars stay out of the startup bundle.
import {
  Language,
  LanguageDescription,
  LanguageSupport,
  ParseContext,
  StreamLanguage,
  defineLanguageFacet,
  forceParsing,
  indentNodeProp,
  languageDataProp,
  syntaxTreeAvailable,
} from "@codemirror/language";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import {
  Parser,
  Tree,
  type Input,
  type PartialParse,
  type TreeBuffer,
  type TreeFragment,
} from "@lezer/common";
import { tags as t } from "@lezer/highlight";
import {
  GFM,
  parseCode,
  parser as baseParser,
  type BlockContext,
  type DelimiterType,
  type InlineContext,
  type Line,
  type MarkdownConfig,
} from "@lezer/markdown";

const CH_DOLLAR = 36;
const CH_HASH = 35;
const CH_PERCENT = 37;
const CH_BANG = 33;
const CH_BRACKET = 91;
const CH_CARET = 94;
const CH_EQUALS = 61;
const CH_BACKSLASH = 92;
const CH_NEWLINE = 10;
const CH_SPACE = 32;

/** Upper bound for an inline construct, so a stray opener cannot scan far. */
const MAX_INLINE_SCAN = 4000;

const HighlightDelim: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };

function findOnLine(cx: InlineContext, from: number, close: string): number {
  // One slice and native searches: a per-character slice made a line full of unclosed
  // openers cost thousands of string allocations per opener.
  const text = cx.slice(from, Math.min(cx.end, from + MAX_INLINE_SCAN + close.length - 1));
  const lineEnd = text.indexOf("\n");
  const found = text.indexOf(close);
  if (found < 0 || (lineEnd >= 0 && found > lineEnd) || found >= MAX_INLINE_SCAN) return -1;
  return from + found;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function parseHighlight(cx: InlineContext, next: number, pos: number): number {
  if (next !== CH_EQUALS || cx.char(pos + 1) !== CH_EQUALS || cx.char(pos + 2) === CH_EQUALS) return -1;
  const before = cx.slice(pos - 1, pos);
  const after = cx.slice(pos + 2, pos + 3);
  // `a==b` is a comparison, not a marker: like `_`, a `==` between two word characters
  // can neither open nor close a highlight.
  if (WORD_CHAR.test(before) && WORD_CHAR.test(after)) return -1;
  return cx.addDelimiter(HighlightDelim, pos, pos + 2, !/\s|^$/.test(after), !/\s|^$/.test(before));
}

function parseWikiBody(cx: InlineContext, start: number, nodeName: string, openLen: number): number {
  const close = findOnLine(cx, start + openLen, "]]");
  if (close < 0 || close === start + openLen) return -1;
  const children = [cx.elt("WikiMark", start, start + openLen)];
  const inner = cx.slice(start + openLen, close);
  const bar = inner.indexOf("|");
  if (bar < 0) {
    children.push(cx.elt("WikiTarget", start + openLen, close));
  } else {
    const split = start + openLen + bar;
    children.push(cx.elt("WikiTarget", start + openLen, split));
    children.push(cx.elt("WikiMark", split, split + 1));
    children.push(cx.elt("WikiAlias", split + 1, close));
  }
  children.push(cx.elt("WikiMark", close, close + 2));
  return cx.addElement(cx.elt(nodeName, start, close + 2, children));
}

/**
 * A stretch of an inline section already scanned for a closing `$` (index 0) or `$$`
 * (index 1) without finding one: `start..end`, stopped by a line break or the scan limit.
 */
interface MathScan {
  start: number;
  end: number;
  lineBreak: boolean;
}

const mathScans = new WeakMap<InlineContext, (MathScan | null)[]>();

function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== CH_DOLLAR) return -1;
  if (pos > cx.offset && cx.char(pos - 1) === CH_BACKSLASH) return -1;
  const markLen = cx.char(pos + 1) === CH_DOLLAR ? 2 : 1;
  const first = cx.char(pos + markLen);
  if (first < 0 || first === CH_SPACE || first === CH_NEWLINE || first === CH_DOLLAR) return -1;
  // A later opener inside a stretch an earlier one scanned in vain can skip that stretch:
  // every scan that reaches a position is at the same point of any backslash escape there,
  // so it would reject the same dollars. Without this, each dollar of a long line of
  // unclosed ones scanned the next 4,000 characters.
  let scans = mathScans.get(cx);
  if (!scans) mathScans.set(cx, (scans = [null, null]));
  const known = scans[markLen - 1];
  let start = pos + markLen;
  let scanFrom = start;
  if (known && start >= known.start && start <= known.end) {
    if (known.lineBreak) return -1;
    start = known.start;
    scanFrom = known.end;
  }
  const limit = Math.min(cx.end, pos + MAX_INLINE_SCAN);
  // One slice from the character before the scan (the space check) to one past the limit
  // (the look-ahead after a closing dollar): no call or allocation per character.
  const base = scanFrom - 1;
  const text = cx.slice(base, Math.min(cx.end, limit + 1));
  let k = scanFrom - base;
  for (; k < limit - base; k++) {
    const ch = text.charCodeAt(k);
    if (ch === CH_NEWLINE) {
      scans[markLen - 1] = { start, end: base + k, lineBreak: true };
      return -1;
    }
    if (ch === CH_BACKSLASH) {
      k++;
      continue;
    }
    if (ch !== CH_DOLLAR) continue;
    if (markLen === 2) {
      if (text.charCodeAt(k + 1) !== CH_DOLLAR) continue;
    } else {
      if (text.charCodeAt(k - 1) === CH_SPACE) continue;
      // "$5 and $6" style prices and "$HOME/$USER" style variables: a closing dollar is
      // never followed by a letter or digit.
      if (WORD_CHAR.test(text.charAt(k + 1))) continue;
    }
    const i = base + k;
    return cx.addElement(
      cx.elt("InlineMath", pos, i + markLen, [
        cx.elt("MathMark", pos, pos + markLen),
        cx.elt("MathMark", i, i + markLen),
      ]),
    );
  }
  scans[markLen - 1] = { start, end: base + k, lineBreak: false };
  return -1;
}

function parseInlineComment(cx: InlineContext, next: number, pos: number): number {
  if (next !== CH_PERCENT || cx.char(pos + 1) !== CH_PERCENT) return -1;
  const close = findOnLine(cx, pos + 2, "%%");
  if (close < 0) return -1;
  return cx.addElement(
    cx.elt("InlineComment", pos, close + 2, [
      cx.elt("CommentMark", pos, pos + 2),
      cx.elt("CommentMark", close, close + 2),
    ]),
  );
}

const TAG_BODY = /^[\p{L}\p{N}_/-]+/u;
const HEX_COLOUR = /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * `#fff`, `#1a2b3c`: a CSS colour, not a tag. Hex codes with a digit are colours; all-letter
 * ones only when they use at most two different letters (`#fff`, `#fafafa`, `#ccc`), so
 * words such as `#cafe` or `#bad` stay tags.
 */
function isColourCode(body: string): boolean {
  if (!HEX_COLOUR.test(body)) return false;
  return /\d/.test(body) || new Set(body.toLowerCase()).size <= 2;
}

function parseTag(cx: InlineContext, next: number, pos: number): number {
  if (next !== CH_HASH) return -1;
  if (pos > cx.offset && !/[\s([{,;:]/.test(cx.slice(pos - 1, pos))) return -1;
  const body = TAG_BODY.exec(cx.slice(pos + 1, Math.min(cx.end, pos + 129)));
  if (!body || /^\d+$/.test(body[0]) || isColourCode(body[0])) return -1;
  return cx.addElement(cx.elt("Tag", pos, pos + 1 + body[0].length));
}

function parseFootnoteRef(cx: InlineContext, next: number, pos: number): number {
  if (next !== CH_BRACKET || cx.char(pos + 1) !== CH_CARET) return -1;
  const close = findOnLine(cx, pos + 2, "]");
  if (close <= pos + 2 || /\s/.test(cx.slice(pos + 2, close))) return -1;
  return cx.addElement(
    cx.elt("FootnoteRef", pos, close + 1, [
      cx.elt("FootnoteMark", pos, pos + 2),
      cx.elt("FootnoteId", pos + 2, close),
      cx.elt("FootnoteMark", close, close + 1),
    ]),
  );
}

function parseCalloutTag(cx: InlineContext, next: number, pos: number): number {
  if (next !== CH_BRACKET || cx.char(pos + 1) !== CH_BANG || pos !== cx.offset) return -1;
  const match = /^\[![\w-]+\][-+]?/.exec(cx.slice(pos, Math.min(cx.end, pos + 40)));
  if (!match) return -1;
  return cx.addElement(cx.elt("CalloutTag", pos, pos + match[0].length));
}

function atTopLevel(cx: BlockContext): boolean {
  return cx.parentType().name === "Document";
}

/**
 * Whether the current line still belongs to the list item, quote or callout the block
 * started in. `Line.depth` is how many enclosing blocks the line continues; it is
 * public at runtime (the built-in fenced code parser uses it) but not in the typings.
 */
function continuesBlock(cx: BlockContext, line: Line): boolean {
  return (line as Line & { depth: number }).depth >= cx.depth;
}

/** Indentation counted from the enclosing list item's content, not the line start. */
const ownIndent = (line: Line) => line.indent - line.baseIndent;

function parseFrontmatter(cx: BlockContext, line: Line): boolean {
  if (cx.lineStart !== 0 || line.text.trimEnd() !== "---") return false;
  // The parser cannot backtrack, so require the next line to look like YAML.
  if (!/^[\w"'.-]+\s*:|^#|^---\s*$/.test(cx.peekLine())) return false;
  const marks = [cx.elt("FrontmatterMark", 0, 3)];
  let lines = 0;
  let next = cx.nextLine();
  while (next && lines++ < 1000) {
    if (/^(---|\.\.\.)\s*$/.test(line.text)) {
      marks.push(cx.elt("FrontmatterMark", cx.lineStart, cx.lineStart + 3));
      next = cx.nextLine();
      break;
    }
    next = cx.nextLine();
  }
  cx.addElement(cx.elt("Frontmatter", 0, cx.prevLineEnd(), marks));
  return true;
}

/**
 * Shared by `$$` math and `%%` comments, which delimit multi-line blocks the same way.
 * They work inside lists, quotes and callouts too, ending with their container.
 * `stopAtBlank`: display maths cannot contain a blank line, so an unclosed `$$` ends
 * at the first one instead of restyling the rest of the document.
 */
function parseDelimitedBlock(
  cx: BlockContext,
  line: Line,
  delim: string,
  nodeName: string,
  markName: string,
  allowSameLine: boolean,
  stopAtBlank: boolean,
): boolean {
  if (ownIndent(line) >= 4 || !line.text.startsWith(delim, line.pos)) return false;
  const from = cx.lineStart + line.pos;
  const sameLine = line.text.indexOf(delim, line.pos + 2);
  if (sameLine >= 0) {
    if (!allowSameLine) return false;
    const end = cx.lineStart + sameLine + 2;
    cx.addElement(
      cx.elt(nodeName, from, end, [cx.elt(markName, from, from + 2), cx.elt(markName, end - 2, end)]),
    );
    cx.nextLine();
    return true;
  }
  const marks = [cx.elt(markName, from, from + 2)];
  let to = cx.lineStart + line.text.length;
  let lines = 0;
  while (cx.nextLine() && continuesBlock(cx, line) && lines++ < 5000) {
    // The blank line is left for the next block.
    if (stopAtBlank && line.pos >= line.text.length) break;
    marks.push(...line.markers);
    to = cx.lineStart + line.text.length;
    const close = line.text.indexOf(delim, line.pos);
    if (close >= 0) {
      to = cx.lineStart + close + 2;
      marks.push(cx.elt(markName, to - 2, to));
      cx.nextLine();
      break;
    }
  }
  cx.addElement(cx.elt(nodeName, from, to, marks));
  return true;
}

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*/;

function parseFootnoteDefinition(cx: BlockContext, line: Line): boolean {
  if (ownIndent(line) >= 4) return false;
  const match = FOOTNOTE_DEF.exec(line.text.slice(line.pos));
  if (!match) return false;
  const from = cx.lineStart + line.pos;
  const labelEnd = from + match[0].trimEnd().length;
  const inlineFrom = from + match[0].length;
  let content = line.text.slice(line.pos + match[0].length);
  let to = cx.lineStart + line.text.length;
  // Indented continuation lines are only read at top level, where they carry no quote or list markers.
  while (atTopLevel(cx) && /^( {2,}|\t)\S/.test(cx.peekLine())) {
    if (!cx.nextLine()) break;
    content += "\n" + line.text;
    to = cx.lineStart + line.text.length;
  }
  cx.addElement(
    cx.elt("FootnoteDefinition", from, to, [
      cx.elt("FootnoteLabel", from, labelEnd),
      ...cx.parser.parseInline(content, inlineFrom),
    ]),
  );
  cx.nextLine();
  return true;
}

const NotepadlyMarkdown: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": t.special(t.content) } },
    { name: "HighlightMark", style: t.processingInstruction },
    { name: "WikiLink", style: t.link },
    { name: "Embed", style: t.link },
    { name: "WikiMark", style: t.processingInstruction },
    { name: "WikiTarget", style: t.url },
    { name: "WikiAlias", style: t.link },
    { name: "InlineMath", style: t.special(t.string) },
    { name: "BlockMath", block: true, style: t.special(t.string) },
    { name: "MathMark", style: t.processingInstruction },
    { name: "InlineComment", style: t.comment },
    { name: "CommentBlock", block: true, style: t.comment },
    { name: "CommentMark", style: t.comment },
    { name: "Tag", style: t.labelName },
    { name: "FootnoteRef", style: t.link },
    { name: "FootnoteMark", style: t.processingInstruction },
    { name: "FootnoteId", style: t.labelName },
    { name: "FootnoteDefinition", block: true },
    { name: "FootnoteLabel", style: t.labelName },
    { name: "CalloutTag", style: t.keyword },
    { name: "Frontmatter", block: true, style: t.meta },
    { name: "FrontmatterMark", style: t.processingInstruction },
  ],
  parseInline: [
    { name: "Highlight", parse: parseHighlight, after: "Emphasis" },
    { name: "CalloutTag", parse: parseCalloutTag, before: "Link" },
    { name: "FootnoteRef", parse: parseFootnoteRef, before: "Link" },
    {
      name: "WikiLink",
      parse: (cx, next, pos) =>
        next === CH_BRACKET && cx.char(pos + 1) === CH_BRACKET ? parseWikiBody(cx, pos, "WikiLink", 2) : -1,
      before: "Link",
    },
    {
      name: "Embed",
      parse: (cx, next, pos) =>
        next === CH_BANG && cx.char(pos + 1) === CH_BRACKET && cx.char(pos + 2) === CH_BRACKET
          ? parseWikiBody(cx, pos, "Embed", 3)
          : -1,
      before: "Image",
    },
    { name: "InlineMath", parse: parseInlineMath, before: "Emphasis" },
    { name: "InlineComment", parse: parseInlineComment, before: "Emphasis" },
    { name: "Tag", parse: parseTag, before: "Emphasis" },
  ],
  parseBlock: [
    { name: "Frontmatter", parse: parseFrontmatter, before: "HorizontalRule" },
    {
      name: "BlockMath",
      parse: (cx, line) => parseDelimitedBlock(cx, line, "$$", "BlockMath", "MathMark", true, true),
      // Inside a paragraph only a lone `$$`, or a line that also holds its closing `$$`,
      // is display maths: `$$5 total` is text (BUGS.md EDIT-9).
      endLeaf: (_cx, line) =>
        line.indent < 4 &&
        line.text.startsWith("$$", line.pos) &&
        (line.text.slice(line.pos + 2).trim() === "" || line.text.indexOf("$$", line.pos + 2) >= 0),
      before: "FencedCode",
    },
    {
      name: "CommentBlock",
      parse: (cx, line) => parseDelimitedBlock(cx, line, "%%", "CommentBlock", "CommentMark", false, false),
      endLeaf: (_cx, line) =>
        line.indent < 4 && line.text.startsWith("%%", line.pos) && line.text.indexOf("%%", line.pos + 2) < 0,
      before: "FencedCode",
    },
    {
      name: "FootnoteDefinition",
      parse: parseFootnoteDefinition,
      endLeaf: (_cx, line) => line.indent < 4 && FOOTNOTE_DEF.test(line.text.slice(line.pos)),
      before: "LinkReference",
    },
  ],
};

// Fenced-code grammars. Nothing is imported until a fence with a language is parsed.
let languages: readonly LanguageDescription[] | null = null;
let languagesLoading: Promise<void> | null = null;

function ensureLanguages(): Promise<void> {
  languagesLoading ??= import("@codemirror/language-data").then((mod) => {
    languages = mod.languages;
  });
  return languagesLoading;
}

const plainCode = new LanguageSupport(
  StreamLanguage.define({
    token(stream) {
      stream.skipToEnd();
      return null;
    },
  }),
);

const pendingLanguages = new Map<string, LanguageDescription>();

function describeLanguage(name: string): LanguageDescription | null {
  if (languages) return LanguageDescription.matchLanguageName(languages, name, true);
  let pending = pendingLanguages.get(name);
  if (!pending) {
    pending = LanguageDescription.of({
      name,
      load: async () => {
        await ensureLanguages();
        const found = LanguageDescription.matchLanguageName(languages ?? [], name, true);
        return found ? found.load() : plainCode;
      },
    });
    pendingLanguages.set(name, pending);
  }
  return pending;
}

function codeParser(info: string) {
  const name = (/\S*/.exec(info)?.[0] ?? "").toLowerCase();
  if (!name || name === "mermaid") return null;
  const found = describeLanguage(name);
  if (!found) return null;
  return found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load());
}

const languageData = defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } });

const noteParser = baseParser.configure([
  GFM,
  NotepadlyMarkdown,
  parseCode({ codeParser }),
  {
    props: [
      languageDataProp.add({ Document: languageData }),
      indentNodeProp.add({ Document: () => null }),
    ],
  },
]);

// ---------- Prefix reuse ----------
//
// @lezer/markdown re-adds every top-level block before an edit one at a time (its reuse
// size cap starts at zero), then rebalances them all, and parseMixed walks them again.
// That makes a keystroke cost grow with the number of blocks above it. This wrapper keeps
// the previous tree's balanced subtrees up to a safe top-level boundary well before the
// first change, and lets the real parser (with its normal fragment reuse) run from there.

/** Unchanged text kept between the cut and the first change. */
const CUT_MARGIN = 2048;
/** Below this, a plain incremental parse is already cheap. */
const MIN_CUT = 32768;
/** Blocks after which a new top-level block may still be continued by the parser. */
const UNSAFE_BEFORE_CUT = new Set(["BulletList", "OrderedList", "CodeBlock", "HTMLBlock", "Frontmatter"]);

interface ReusePlan {
  cut: number;
  children: (Tree | TreeBuffer)[];
  positions: number[];
}

function collectPrefix(tree: Tree, cut: number): ReusePlan | null {
  const children: (Tree | TreeBuffer)[] = [];
  const positions: number[] = [];
  const walk = (node: Tree, offset: number): boolean => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const from = offset + node.positions[i];
      const to = from + child.length;
      if (to <= cut) {
        children.push(child);
        positions.push(from);
      } else if (from < cut) {
        if (!(child instanceof Tree) || !child.type.isAnonymous) return false;
        return walk(child, from);
      } else {
        return true;
      }
    }
    return true;
  };
  return walk(tree, 0) ? { cut, children, positions } : null;
}

function planReuse(
  input: Input,
  fragments: readonly TreeFragment[],
  ranges: readonly { from: number; to: number }[],
): ReusePlan | null {
  if (ranges.length !== 1 || ranges[0].from !== 0) return null;
  const head = fragments.find((f) => f.from === 0 && f.offset === 0 && !f.openStart);
  if (!head || head.tree.type.name !== "Document") return null;
  const limit = head.to - CUT_MARGIN;
  if (limit < MIN_CUT) return null;

  let previous = head.tree.topNode.childBefore(limit);
  for (let tries = 0; previous && tries < 64; tries++) {
    const next = previous.nextSibling;
    if (next && next.from <= limit && next.from >= MIN_CUT && !UNSAFE_BEFORE_CUT.has(previous.name)) {
      // The boundary must be a blank line, so nothing before it can continue into the cut.
      if (/\n[ \t]*\n/.test(input.read(previous.to, next.from))) return collectPrefix(head.tree, next.from);
    }
    previous = previous.prevSibling;
  }
  return null;
}

class PrefixReuseParser extends Parser {
  constructor(private readonly inner: Parser) {
    super();
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const plan = planReuse(input, fragments, ranges);
    if (!plan) return this.inner.startParse(input, fragments, ranges);
    const parse = this.inner.startParse(input, fragments, [{ from: plan.cut, to: ranges[0].to }]);
    return {
      advance() {
        const done = parse.advance();
        if (!done) return null;
        return new Tree(
          done.type,
          [...plan.children, ...done.children],
          [...plan.positions, ...done.positions.map((pos) => pos + plan.cut)],
          plan.cut + done.length,
        );
      },
      get parsedPos() {
        return parse.parsedPos;
      },
      stopAt(pos: number) {
        parse.stopAt(pos);
      },
      get stoppedAt() {
        return parse.stoppedAt;
      },
    };
  }
}

/** Exported for verification: parses with the wrapper exactly as the editor does. */
export const notepadlyParser: Parser = new PrefixReuseParser(noteParser);
export const plainMarkdownParser: Parser = noteParser;

export const markdownLanguage = new Language(languageData, notepadlyParser, [], "markdown");
export const markdownSupport = new LanguageSupport(markdownLanguage);

const PARSE_SLICE_MS = 10;

/**
 * Keeps the parser up with a viewport that jumped far ahead. CodeMirror's own worker only
 * parses a little past the viewport and is rationed to a few seconds per half minute, so
 * after a jump in a large file every keystroke would burn its parse budget catching up.
 * This advances the same incremental parse in short idle slices, never during an update.
 */
export const parseAhead = ViewPlugin.fromClass(
  class {
    private idle = 0;

    constructor(private readonly view: EditorView) {
      this.schedule();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.schedule();
    }

    private schedule(): void {
      if (this.idle || syntaxTreeAvailable(this.view.state, this.view.viewport.to)) return;
      this.idle = requestIdleCallback(() => this.step(), { timeout: 60 });
    }

    private step(): void {
      this.idle = 0;
      if (!forceParsing(this.view, this.view.viewport.to, PARSE_SLICE_MS)) this.schedule();
    }

    destroy(): void {
      if (this.idle) cancelIdleCallback(this.idle);
      this.idle = 0;
    }
  },
);
