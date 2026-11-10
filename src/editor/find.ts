// Find and replace through @codemirror/search cursors, without its panel.
import { SearchQuery } from "@codemirror/search";
import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { FindQuery, FindResult } from "./api";

/** `FindResult.total` stops here; a total equal to this means "at least this many". */
export const FIND_COUNT_LIMIT = 10000;

const setQuery = StateEffect.define<SearchQuery | null>();

const queryField = StateField.define<SearchQuery | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setQuery)) value = effect.value;
    return value;
  },
});

const matchMark = Decoration.mark({ class: "cm-find-match" });
const currentMark = Decoration.mark({ class: "cm-find-current" });

function buildMatches(view: EditorView): DecorationSet {
  const { state } = view;
  const query = state.field(queryField);
  if (!query) return Decoration.none;
  const main = state.selection.main;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(state, from, to);
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      const match = step.value;
      if (match.to === match.from) continue;
      const isCurrent = match.from === main.from && match.to === main.to;
      ranges.push((isCurrent ? currentMark : matchMark).range(match.from, match.to));
    }
  }
  return Decoration.set(ranges, true);
}

const matchPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMatches(view);
    }
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.state.field(queryField) !== update.startState.field(queryField)
      ) {
        this.decorations = buildMatches(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const findExtension = [queryField, matchPlugin];

interface Match {
  from: number;
  to: number;
}

interface Session {
  options: FindQuery;
  query: SearchQuery;
  /** Doc identity the counts below belong to; a mismatch forces a recount. */
  doc: EditorState["doc"] | null;
  total: number;
  current: number;
}

function firstFrom(state: EditorState, query: SearchQuery, from: number, to: number): Match | null {
  const step = query.getCursor(state, from, to).next();
  return step.done ? null : { from: step.value.from, to: step.value.to };
}

function lastBefore(state: EditorState, query: SearchQuery, from: number, to: number): Match | null {
  // Search backwards in growing windows so "previous" stays cheap near the cursor.
  let windowSize = 4096;
  let end = to;
  for (;;) {
    const start = Math.max(from, end - windowSize);
    const cursor = query.getCursor(state, start, to);
    let last: Match | null = null;
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      if (step.value.to > to) break;
      last = { from: step.value.from, to: step.value.to };
    }
    if (last) return last;
    if (start === from) return null;
    end = start;
    windowSize *= 4;
  }
}

/** One find session per editor. The engine resets it when the active tab changes. */
export class FindController {
  private session: Session | null = null;

  constructor(private readonly getView: () => EditorView | null) {}

  private recount(view: EditorView, session: Session): void {
    const main = view.state.selection.main;
    const cursor = session.query.getCursor(view.state);
    let total = 0;
    let current = 0;
    for (let step = cursor.next(); !step.done && total < FIND_COUNT_LIMIT; step = cursor.next()) {
      total++;
      if (step.value.from === main.from && step.value.to === main.to) current = total;
    }
    session.total = total;
    session.current = current;
    session.doc = view.state.doc;
  }

  private result(view: EditorView, session: Session): FindResult {
    if (session.doc !== view.state.doc) this.recount(view, session);
    return { total: session.total, current: session.current };
  }

  private select(view: EditorView, match: Match): void {
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: "center" }),
      userEvent: "select.search",
    });
  }

  find(options: FindQuery): FindResult {
    const view = this.getView();
    if (!view) return { total: 0, current: 0 };
    if (!options.search) {
      this.clear();
      return { total: 0, current: 0 };
    }
    const query = new SearchQuery({
      search: options.search,
      replace: options.replace,
      caseSensitive: options.caseSensitive,
      literal: true,
    });
    const session: Session = { options, query, doc: null, total: 0, current: 0 };
    this.session = session;
    view.dispatch({ effects: setQuery.of(query) });
    const { state } = view;
    const start = state.selection.main.from;
    const match =
      firstFrom(state, query, start, state.doc.length) ??
      (options.wrap ? firstFrom(state, query, 0, start) : null);
    if (match) this.select(view, match);
    return this.result(view, session);
  }

  next(): FindResult {
    return this.step(1);
  }

  prev(): FindResult {
    return this.step(-1);
  }

  private step(dir: 1 | -1): FindResult {
    const view = this.getView();
    const session = this.session;
    if (!view || !session) return { total: 0, current: 0 };
    const { state } = view;
    const { query, options } = session;
    const length = state.doc.length;
    const main = state.selection.main;
    let match: Match | null;
    let wrapped = false;
    if (dir === 1) {
      match = firstFrom(state, query, main.to, length);
      if (!match && options.wrap) {
        match = firstFrom(state, query, 0, main.to);
        wrapped = !!match;
      }
    } else {
      match = lastBefore(state, query, 0, main.from);
      if (!match && options.wrap) {
        match = lastBefore(state, query, main.from, length);
        wrapped = !!match;
      }
    }
    if (!match) return this.result(view, session);

    const countValid = session.doc === state.doc && session.current > 0;
    this.select(view, match);
    if (!countValid) {
      this.recount(view, session);
    } else if (session.total < FIND_COUNT_LIMIT) {
      if (dir === 1) session.current = wrapped ? 1 : session.current + 1;
      else session.current = wrapped ? session.total : session.current - 1;
    } else {
      // Past the counting bound an exact index is unknown, so report it as not computed.
      session.current = 0;
    }
    return { total: session.total, current: session.current };
  }

  replaceCurrent(): FindResult {
    const view = this.getView();
    const session = this.session;
    if (!view || !session) return { total: 0, current: 0 };
    const { state } = view;
    const main = state.selection.main;
    const { query } = session;
    const atMatch = firstFrom(state, query, main.from, main.to);
    if (main.empty || !atMatch || atMatch.from !== main.from || atMatch.to !== main.to) {
      return this.step(1);
    }
    const insert = session.options.replace;
    view.dispatch({
      changes: { from: main.from, to: main.to, insert },
      selection: { anchor: main.from + insert.length },
      userEvent: "input.replace",
    });
    return this.step(1);
  }

  replaceAll(): number {
    const view = this.getView();
    const session = this.session;
    if (!view || !session) return 0;
    const { state } = view;
    const cursor = session.query.getCursor(state);
    const changes: { from: number; to: number; insert: string }[] = [];
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      changes.push({ from: step.value.from, to: step.value.to, insert: session.options.replace });
    }
    if (changes.length) view.dispatch({ changes, userEvent: "input.replace.all" });
    session.doc = null;
    return changes.length;
  }

  clear(): void {
    this.session = null;
    const view = this.getView();
    if (view && view.state.field(queryField, false)) view.dispatch({ effects: setQuery.of(null) });
  }
}
