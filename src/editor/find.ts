// Find and replace through @codemirror/search cursors, without its panel.
import { SearchQuery } from "@codemirror/search";
import { StateEffect, StateField, type EditorState, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { FindQuery, FindResult } from "./api";

/** `FindResult.total` stops here; a total equal to this means "at least this many". */
export const FIND_COUNT_LIMIT = 10000;

/** How long a match count may run on the UI thread before it yields (BUGS.md M14). */
const COUNT_SLICE_MS = 8;
/** Text scanned per cursor: the count checks the clock between chunks. */
const SCAN_CHUNK = 1 << 18;
/** Text after the cursor that `find` scans at once for the first match; the rest is scanned in slices. */
const FIRST_MATCH_SYNC = 1 << 20;

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

interface Match {
  from: number;
  to: number;
  /** The regular expression match, for `$1` in the replacement. */
  groups?: RegExpExecArray;
}

function usable(query: SearchQuery | null): query is SearchQuery {
  return !!query && query.valid;
}

function buildMatches(view: EditorView): { set: DecorationSet; current: Match | null } {
  const { state } = view;
  const query = state.field(queryField);
  if (!usable(query)) return { set: Decoration.none, current: null };
  const main = state.selection.main;
  const ranges: Range<Decoration>[] = [];
  let current: Match | null = null;
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(state, from, to);
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      const match = step.value;
      if (match.to === match.from) continue;
      const isCurrent = match.from === main.from && match.to === main.to;
      if (isCurrent) current = { from: match.from, to: match.to };
      ranges.push((isCurrent ? currentMark : matchMark).range(match.from, match.to));
    }
  }
  return { set: Decoration.set(ranges, true), current };
}

const matchPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private current: Match | null;
    constructor(view: EditorView) {
      ({ set: this.decorations, current: this.current } = buildMatches(view));
    }
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.state.field(queryField) !== update.startState.field(queryField)
      ) {
        ({ set: this.decorations, current: this.current } = buildMatches(update.view));
      } else if (update.selectionSet) {
        this.moveCurrent(update.state);
      }
    }
    /** Only the current-match mark follows the selection: swap two marks, search nothing. */
    private moveCurrent(state: EditorState): void {
      const main = state.selection.main;
      const old = this.current;
      if (old && old.from === main.from && old.to === main.to) return;
      let next: Match | null = null;
      if (!main.empty) {
        this.decorations.between(main.from, main.to, (from, to, value) => {
          if (value === matchMark && from === main.from && to === main.to) {
            next = { from, to };
            return false;
          }
        });
      }
      if (!old && !next) return;
      const add: Range<Decoration>[] = [];
      if (old) add.push(matchMark.range(old.from, old.to));
      if (next) add.push(currentMark.range(main.from, main.to));
      this.decorations = this.decorations.update({
        filter: (from, to, value) =>
          !(old && value === currentMark && from === old.from && to === old.to) &&
          !(next && value === matchMark && from === main.from && to === main.to),
        add,
        sort: true,
      });
      this.current = next;
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const findExtension = [queryField, matchPlugin];

/** The active Find query of a state, or null; rendered tables mark its matches (BUGS.md TAB-1). */
export function findQueryOf(state: EditorState): SearchQuery | null {
  return state.field(queryField, false) ?? null;
}

/**
 * Non-empty matches of `query` in `from..to`, in order and without overlaps, scanned in
 * chunks that end at a line break: `null` is yielded after each chunk so a caller can yield
 * to the UI. Matches longer than the chunk overlap (multi-line patterns) may be missed at a
 * chunk boundary.
 */
function* scanMatches(state: EditorState, query: SearchQuery, from: number, to: number): Generator<Match | null> {
  const { doc } = state;
  const overlap = 4096 + query.search.length;
  let pos = from;
  while (pos < to) {
    let end = Math.min(to, pos + SCAN_CHUNK);
    if (end < to) {
      const line = doc.lineAt(end);
      if (line.to + 1 - pos <= 4 * SCAN_CHUNK) end = Math.min(to, line.to + 1);
    }
    let next = end;
    const cursor = query.getCursor(state, pos, end < to ? Math.min(to, end + overlap) : to);
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      const match = step.value as Match & { match?: RegExpExecArray };
      if (match.from >= end) break;
      if (match.to === match.from) continue;
      next = Math.max(next, match.to);
      yield { from: match.from, to: match.to, groups: match.match };
    }
    pos = next;
    yield null;
  }
}

function firstFrom(state: EditorState, query: SearchQuery, from: number, to: number): Match | null {
  for (const match of scanMatches(state, query, from, to)) if (match) return match;
  return null;
}

function lastBefore(state: EditorState, query: SearchQuery, from: number, to: number): Match | null {
  // Search backwards in growing windows so "previous" stays cheap near the cursor.
  let windowSize = 4096;
  let end = to;
  for (;;) {
    const start = Math.max(from, end - windowSize);
    let last: Match | null = null;
    for (const match of scanMatches(state, query, start, to)) {
      if (!match) continue;
      if (match.to > to) break;
      last = match;
    }
    if (last) return last;
    if (start === from) return null;
    end = start;
    windowSize *= 4;
  }
}

/** The replacement text: as typed, or with `$&`, `$1`… filled in for a regular expression. */
function replacementFor(options: FindQuery, match: Match): string {
  const groups = match.groups;
  if (!options.regexp || !groups) return options.replace;
  return options.replace.replace(/\$([$&]|\d+)/g, (all: string, ref: string) => {
    if (ref === "$") return "$";
    if (ref === "&") return groups[0];
    for (let length = ref.length; length > 0; length--) {
      const n = Number(ref.slice(0, length));
      if (n > 0 && n < groups.length) return (groups[n] ?? "") + ref.slice(length);
    }
    return all;
  });
}

/** A match count that runs in slices, for one version of the document. */
interface Count {
  doc: Text;
  scan: Generator<Match | null>;
  /** Matches found so far, at most FIND_COUNT_LIMIT. */
  froms: number[];
  tos: number[];
  done: boolean;
}

interface Session {
  options: FindQuery;
  query: SearchQuery;
  count: Count | null;
  /** The match `current` points at, beyond the counting bound; any other selection makes it stale. */
  current: number;
  at: Match | null;
  /** The first match from `start` is still being looked for, unless the selection moves. */
  pendingSelect: { start: number; selection: EditorState["selection"] } | null;
}

const NONE: FindResult = { total: 0, current: 0 };
/** `FindController.timer` while a slice runs in a later task. */
const BACKGROUND = -1;

/** One find session per editor. The engine resets it when the active tab changes. */
export class FindController {
  private session: Session | null = null;
  private timer = 0;
  private listener: ((result: FindResult) => void) | null = null;

  constructor(private readonly getView: () => EditorView | null) {}

  /** Called with the result once a count that `find` left pending is complete. */
  setListener(listener: ((result: FindResult) => void) | null): void {
    this.listener = listener;
  }

  private startCount(view: EditorView, session: Session): void {
    const { state } = view;
    // A running index from another version of the text means nothing.
    session.at = null;
    session.current = 0;
    session.count = {
      doc: state.doc,
      scan: scanMatches(state, session.query, 0, state.doc.length),
      froms: [],
      tos: [],
      done: false,
    };
    this.runCount(view, session);
  }

  /** Counts for at most COUNT_SLICE_MS, then continues in a later task if needed. */
  private runCount(view: EditorView, session: Session): void {
    const count = session.count;
    if (!count) return;
    const deadline = performance.now() + COUNT_SLICE_MS;
    while (!count.done) {
      const step = count.scan.next();
      if (step.done) {
        count.done = true;
        break;
      }
      const match = step.value;
      if (!match) {
        if (performance.now() >= deadline) break;
        continue;
      }
      if (count.froms.length < FIND_COUNT_LIMIT) {
        count.froms.push(match.from);
        count.tos.push(match.to);
      }
      const pending = session.pendingSelect;
      if (pending && match.from >= pending.start) this.resolvePending(view, session, match);
      if (count.froms.length >= FIND_COUNT_LIMIT && !session.pendingSelect) count.done = true;
    }
    if (count.done && session.pendingSelect) {
      // Nothing after the start: wrap to the first match, when wrapping.
      const first = count.froms.length ? { from: count.froms[0], to: count.tos[0] } : null;
      this.resolvePending(view, session, session.options.wrap ? first : null);
    }
    if (!count.done) this.schedule(view, session);
    // A count finished in a later task: `find` has long returned, so tell the find bar.
    else if (this.timer === BACKGROUND) this.notify(view, session);
  }

  private schedule(view: EditorView, session: Session): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = BACKGROUND;
      if (this.session === session && this.getView() === view) {
        // The document changed mid-count: count the new one.
        if (session.count && session.count.doc !== view.state.doc) this.startCount(view, session);
        else this.runCount(view, session);
      }
      if (this.timer === BACKGROUND) this.timer = 0;
    }, 0);
  }

  private notify(view: EditorView, session: Session): void {
    if (this.session === session) this.listener?.(this.result(view, session));
  }

  private resolvePending(view: EditorView, session: Session, match: Match | null): void {
    const pending = session.pendingSelect;
    session.pendingSelect = null;
    // The user moved on while the search ran: leave the selection alone.
    if (!pending || !match || !view.state.selection.eq(pending.selection)) return;
    this.select(view, match);
    if (this.timer === BACKGROUND) this.notify(view, session);
  }

  private indexOf(count: Count, from: number, to: number): number {
    const { froms } = count;
    let lo = 0;
    let hi = froms.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (froms[mid] < from) lo = mid + 1;
      else if (froms[mid] > from) hi = mid - 1;
      else return count.tos[mid] === to ? mid + 1 : 0;
    }
    return 0;
  }

  private result(view: EditorView, session: Session): FindResult {
    if (!session.query.valid) return { total: 0, current: 0, invalid: true };
    if (session.count?.doc !== view.state.doc) {
      if (this.timer > 0) clearTimeout(this.timer);
      this.timer = 0;
      this.startCount(view, session);
    }
    const count = session.count!;
    const main = view.state.selection.main;
    let current = main.empty ? 0 : this.indexOf(count, main.from, main.to);
    // Past the counting bound only a running index, kept by `step`, knows where it is.
    if (!current && session.at && session.at.from === main.from && session.at.to === main.to) current = session.current;
    const result: FindResult = { total: count.froms.length, current };
    if (!count.done) result.pending = true;
    return result;
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
    if (!view) return NONE;
    if (!options.search) {
      this.clear();
      return NONE;
    }
    clearTimeout(this.timer);
    this.timer = 0;
    const query = new SearchQuery({
      search: options.search,
      replace: options.replace,
      caseSensitive: options.caseSensitive,
      literal: !options.regexp,
      regexp: !!options.regexp,
      wholeWord: !!options.wholeWord,
    });
    const session: Session = { options, query, count: null, current: 0, at: null, pendingSelect: null };
    this.session = session;
    view.dispatch({ effects: setQuery.of(query) });
    if (!query.valid) return { total: 0, current: 0, invalid: true };
    const { state } = view;
    const start = state.selection.main.from;
    const length = state.doc.length;
    // Only the text near the cursor is searched at once; the count finds a match further on.
    const syncEnd = Math.min(length, start + FIRST_MATCH_SYNC);
    let match = firstFrom(state, query, start, syncEnd);
    if (!match && syncEnd === length && options.wrap && start <= FIRST_MATCH_SYNC) match = firstFrom(state, query, 0, start);
    if (match) this.select(view, match);
    else if (syncEnd < length || (options.wrap && start > FIRST_MATCH_SYNC)) {
      // The count selects the first match from the cursor (or wraps) when it gets there.
      session.pendingSelect = { start, selection: view.state.selection };
    }
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
    if (!view || !session) return NONE;
    if (!session.query.valid) return { total: 0, current: 0, invalid: true };
    session.pendingSelect = null;
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

    // The running index only holds while the selection is still the match it counted.
    const before = this.result(view, session);
    const known = before.current > 0 && session.count?.doc === state.doc ? before.current : 0;
    this.select(view, match);
    const after = this.result(view, session);
    let current = after.current;
    const count = session.count!;
    if (!current && known && count.done && count.froms.length >= FIND_COUNT_LIMIT) {
      // Beyond the counting bound: counting on from a known match stays exact. Wrapping
      // back to the last match: its index is unknown.
      if (dir === 1) current = wrapped ? 1 : known + 1;
      else if (!wrapped) current = known - 1;
    }
    session.current = current;
    session.at = current > 0 ? { from: match.from, to: match.to } : null;
    return { ...after, current };
  }

  replaceCurrent(): FindResult {
    const view = this.getView();
    const session = this.session;
    if (!view || !session) return NONE;
    if (!session.query.valid) return { total: 0, current: 0, invalid: true };
    const { state } = view;
    const main = state.selection.main;
    const { query } = session;
    const atMatch = main.empty ? null : firstFrom(state, query, main.from, main.to);
    if (!atMatch || atMatch.from !== main.from || atMatch.to !== main.to) {
      return this.step(1);
    }
    const insert = replacementFor(session.options, atMatch);
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
    if (!view || !session || !session.query.valid) return 0;
    const { state } = view;
    const changes: { from: number; to: number; insert: string }[] = [];
    for (const match of scanMatches(state, session.query, 0, state.doc.length)) {
      if (match) changes.push({ from: match.from, to: match.to, insert: replacementFor(session.options, match) });
    }
    if (changes.length) view.dispatch({ changes, userEvent: "input.replace.all" });
    session.count = null;
    return changes.length;
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    this.session = null;
    const view = this.getView();
    if (view && view.state.field(queryField, false)) view.dispatch({ effects: setQuery.of(null) });
  }
}
