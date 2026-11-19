// @vitest-environment jsdom
import "../test/dom";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SearchQuery } from "@codemirror/search";
import { describe, expect, it, vi } from "vitest";
import type { FindQuery, FindResult } from "./api";
import { FIND_COUNT_LIMIT, FindController, findExtension } from "./find";

function setup(text: string, cursor = 0) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: text, selection: { anchor: cursor }, extensions: [findExtension, history()] }),
  });
  const finder = new FindController(() => view);
  const selected = () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  const at = () => view.state.selection.main.from;
  return { view, finder, selected, at };
}

const query = (search: string, options: Partial<FindQuery> = {}): FindQuery => ({
  search,
  replace: "",
  caseSensitive: false,
  wrap: true,
  ...options,
});

describe("find", () => {
  it("selects the first match after the cursor and counts all matches", () => {
    const { finder, selected, at } = setup("cat dog cat dog cat", 5);
    expect(finder.find(query("cat"))).toEqual({ total: 3, current: 2 });
    expect(selected()).toBe("cat");
    expect(at()).toBe(8);
  });

  it("wraps to the start when nothing follows the cursor", () => {
    const { finder, at } = setup("cat dog", 6);
    expect(finder.find(query("cat"))).toEqual({ total: 1, current: 1 });
    expect(at()).toBe(0);
  });

  it("does not wrap when wrapping is off", () => {
    const { finder, at } = setup("cat dog", 6);
    expect(finder.find(query("cat", { wrap: false }))).toEqual({ total: 1, current: 0 });
    expect(at()).toBe(6);
  });

  it("ignores case unless asked", () => {
    expect(setup("Cat CAT cat").finder.find(query("cat")).total).toBe(3);
    expect(setup("Cat CAT cat").finder.find(query("cat", { caseSensitive: true })).total).toBe(1);
  });

  it("searches for the literal text, not a regular expression", () => {
    const { finder } = setup("a.b axb (x) \\n");
    expect(finder.find(query("a.b")).total).toBe(1);
    expect(finder.find(query("(x)")).total).toBe(1);
    expect(finder.find(query("\\n")).total).toBe(1);
  });

  it("finds Urdu text and emoji", () => {
    const { finder, selected } = setup("سلام دنیا 😀 سلام");
    expect(finder.find(query("سلام"))).toEqual({ total: 2, current: 1 });
    expect(finder.find(query("😀")).total).toBe(1);
    expect(selected()).toBe("😀");
  });

  it("finds text across a line break", () => {
    const { finder } = setup("end of one\nstart of two");
    expect(finder.find(query("one\nstart")).total).toBe(1);
  });

  it("reports nothing for an empty query or a query with no match", () => {
    const { finder } = setup("text");
    expect(finder.find(query(""))).toEqual({ total: 0, current: 0 });
    expect(finder.find(query("zzz"))).toEqual({ total: 0, current: 0 });
  });

  it("stops counting at the limit so huge documents stay responsive", () => {
    const { finder } = setup("a".repeat(FIND_COUNT_LIMIT + 50));
    expect(finder.find(query("a")).total).toBe(FIND_COUNT_LIMIT);
  });

  // BUGS.md H10 (part 3): "1 of 10000" became "0 of 10000" after Next.
  it("keeps an exact index when stepping past the counting limit", () => {
    const { finder } = setup("a".repeat(FIND_COUNT_LIMIT + 50));
    expect(finder.find(query("a"))).toEqual({ total: FIND_COUNT_LIMIT, current: 1 });
    expect(finder.next()).toEqual({ total: FIND_COUNT_LIMIT, current: 2 });
    expect(finder.prev()).toEqual({ total: FIND_COUNT_LIMIT, current: 1 });
    // Wrapping back to the last match: its index is unknown.
    expect(finder.prev()).toEqual({ total: FIND_COUNT_LIMIT, current: 0 });
  });

  it("does nothing without an editor", () => {
    const finder = new FindController(() => null);
    expect(finder.find(query("x"))).toEqual({ total: 0, current: 0 });
    expect(finder.next()).toEqual({ total: 0, current: 0 });
    expect(finder.replaceAll()).toBe(0);
  });
});

describe("find next and previous", () => {
  it("steps forward and backward through matches with a running index", () => {
    const { finder, at } = setup("x1 x2 x3");
    finder.find(query("x"));
    expect(finder.next()).toEqual({ total: 3, current: 2 });
    expect(at()).toBe(3);
    expect(finder.next()).toEqual({ total: 3, current: 3 });
    expect(finder.prev()).toEqual({ total: 3, current: 2 });
  });

  it("wraps around in both directions", () => {
    const { finder, at } = setup("x1 x2 x3");
    finder.find(query("x"));
    finder.next();
    finder.next();
    expect(finder.next()).toEqual({ total: 3, current: 1 });
    expect(at()).toBe(0);
    expect(finder.prev()).toEqual({ total: 3, current: 3 });
    expect(at()).toBe(6);
  });

  it("stays on the last match when wrapping is off", () => {
    const { finder, at } = setup("x1 x2");
    finder.find(query("x", { wrap: false }));
    finder.next();
    expect(finder.next()).toEqual({ total: 2, current: 2 });
    expect(at()).toBe(3);
  });

  it("recounts after the document was edited", () => {
    const { view, finder } = setup("x x x");
    finder.find(query("x"));
    view.dispatch({ changes: { from: 0, insert: "x " } });
    expect(finder.next().total).toBe(4);
  });

  // Regression for BUGS.md H10 (first part): after the cursor moved away, Next
  // used to add 1 to the old index instead of reporting the real position.
  it("reports the real index after the cursor was moved elsewhere", () => {
    const { view, finder } = setup("x0 x1 x2 x3 x4 x5");
    finder.find(query("x"));
    view.dispatch({ selection: { anchor: 13 } });
    // From inside "x4", the next match is "x5", the sixth.
    expect(finder.next()).toEqual({ total: 6, current: 6 });
    expect(view.state.selection.main.from).toBe(15);
    // Previous from inside "x1" selects "x1", the second match.
    view.dispatch({ selection: { anchor: 4 } });
    expect(finder.prev()).toEqual({ total: 6, current: 2 });
    expect(view.state.selection.main.from).toBe(3);
  });

  it("finds a match that begins right at the cursor of a previous match", () => {
    const { finder, at } = setup("aaaa");
    finder.find(query("aa"));
    expect(at()).toBe(0);
    finder.next();
    expect(at()).toBe(2);
  });
});

describe("replace", () => {
  it("replaces the selected match and moves to the next one", () => {
    const { view, finder, at } = setup("one two one");
    finder.find(query("one", { replace: "1" }));
    expect(finder.replaceCurrent()).toEqual({ total: 1, current: 1 });
    expect(view.state.doc.toString()).toBe("1 two one");
    expect(at()).toBe(6);
  });

  it("first moves to a match when the selection is not one", () => {
    const { view, finder } = setup("one two one");
    finder.find(query("one", { replace: "1" }));
    view.dispatch({ selection: { anchor: 4, head: 7 } });
    finder.replaceCurrent();
    expect(view.state.doc.toString()).toBe("one two one");
    expect(view.state.selection.main.from).toBe(8);
  });

  it("inserts the replacement text literally", () => {
    const { view, finder } = setup("price");
    finder.find(query("price", { replace: "$& \\n $1" }));
    finder.replaceAll();
    expect(view.state.doc.toString()).toBe("$& \\n $1");
  });

  it("replaces every match, returns the count, and undoes in one step", () => {
    const { view, finder } = setup("a-b-c-d");
    finder.find(query("-", { replace: " — " }));
    expect(finder.replaceAll()).toBe(3);
    expect(view.state.doc.toString()).toBe("a — b — c — d");
    undo(view);
    expect(view.state.doc.toString()).toBe("a-b-c-d");
  });

  it("can replace with an empty string to delete matches", () => {
    const { view, finder } = setup("x,y,,z");
    finder.find(query(","));
    expect(finder.replaceAll()).toBe(3);
    expect(view.state.doc.toString()).toBe("xyz");
  });

  it("does not loop when the replacement contains the search text", () => {
    const { view, finder } = setup("a a");
    finder.find(query("a", { replace: "aa" }));
    expect(finder.replaceAll()).toBe(2);
    expect(view.state.doc.toString()).toBe("aa aa");
  });

  it("replaces all matches even beyond the counting limit", () => {
    const { view, finder } = setup("b".repeat(FIND_COUNT_LIMIT + 5));
    finder.find(query("b", { replace: "c" }));
    expect(finder.replaceAll()).toBe(FIND_COUNT_LIMIT + 5);
    expect(view.state.doc.toString()).toBe("c".repeat(FIND_COUNT_LIMIT + 5));
  });

  it("replaces case-insensitively only when asked", () => {
    const { view, finder } = setup("Foo foo");
    finder.find(query("foo", { replace: "bar", caseSensitive: true }));
    finder.replaceAll();
    expect(view.state.doc.toString()).toBe("Foo bar");
  });
});

describe("clearing", () => {
  it("forgets the session so Next and Replace all do nothing", () => {
    const { view, finder } = setup("x x");
    finder.find(query("x", { replace: "y" }));
    finder.clear();
    expect(finder.next()).toEqual({ total: 0, current: 0 });
    expect(finder.replaceAll()).toBe(0);
    expect(view.state.doc.toString()).toBe("x x");
  });
});

describe("whole word and regular expressions", () => {
  it("matches whole words only when asked", () => {
    const { finder } = setup("cat concat cat_x cat.");
    expect(finder.find(query("cat")).total).toBe(4);
    expect(finder.find(query("cat", { wholeWord: true })).total).toBe(2);
  });

  it("searches with a regular expression and fills groups into the replacement", () => {
    const { view, finder } = setup("a1 b22 c333");
    expect(finder.find(query("\\d+", { regexp: true }))).toEqual({ total: 3, current: 1 });
    finder.find(query("([a-z])(\\d+)", { regexp: true, replace: "$2$1[$&]$$" }));
    expect(finder.replaceAll()).toBe(3);
    expect(view.state.doc.toString()).toBe("1a[a1]$ 22b[b22]$ 333c[c333]$");
  });

  it("Replace fills groups for the current match too", () => {
    const { view, finder } = setup("x=1 y=2");
    finder.find(query("(\\w)=(\\d)", { regexp: true, replace: "$2=$1" }));
    finder.replaceCurrent();
    expect(view.state.doc.toString()).toBe("1=x y=2");
  });

  it("reports an invalid expression and does nothing with it", () => {
    const { view, finder } = setup("a(b");
    expect(finder.find(query("(", { regexp: true }))).toEqual({ total: 0, current: 0, invalid: true });
    expect(finder.next()).toEqual({ total: 0, current: 0, invalid: true });
    expect(finder.replaceAll()).toBe(0);
    expect(view.state.doc.toString()).toBe("a(b");
  });

  it("skips empty matches instead of getting stuck on them", () => {
    const { finder, selected } = setup("abc xx abc");
    expect(finder.find(query("x*", { regexp: true }))).toEqual({ total: 1, current: 1 });
    expect(selected()).toBe("xx");
    expect(finder.next()).toEqual({ total: 1, current: 1 });
  });
});

// BUGS.md M14: the whole file was scanned on the UI thread on each keystroke.
describe("M14: counting a big document in slices", () => {
  const big = (needleAt: "start" | "end" | "both") => {
    const filler = "lorem ipsum dolor sit amet\n".repeat(400_000); // ~11 MB
    return needleAt === "start" ? `needle ${filler}` : needleAt === "end" ? `${filler}needle` : `needle ${filler}needle`;
  };
  const nextResult = (finder: FindController) =>
    new Promise<FindResult>((resolve) => finder.setListener((result) => !result.pending && resolve(result)));

  it("returns a partial count at once and delivers the full count when ready", async () => {
    const { finder, at } = setup(big("both"));
    const done = nextResult(finder);
    const first = finder.find(query("needle"));
    expect(first).toMatchObject({ current: 1, pending: true });
    expect(at()).toBe(0);
    expect(await done).toEqual({ total: 2, current: 1 });
  }, 30_000);

  it("selects a match far past the cursor once the count reaches it", async () => {
    const { finder, view, selected } = setup(big("end"));
    const done = nextResult(finder);
    expect(finder.find(query("needle"))).toMatchObject({ total: 0, current: 0, pending: true });
    expect(view.state.selection.main.empty).toBe(true);
    expect(await done).toEqual({ total: 1, current: 1 });
    expect(selected()).toBe("needle");
  }, 30_000);

  it("leaves the selection alone if the user moved while it searched", async () => {
    const { finder, view } = setup(big("end"));
    const done = nextResult(finder);
    finder.find(query("needle"));
    view.dispatch({ selection: { anchor: 5 } });
    expect(await done).toEqual({ total: 1, current: 0 });
    expect(view.state.selection.main.head).toBe(5);
  }, 30_000);
});

describe("match highlights", () => {
  it("moves only the current-match mark when the selection changes, without searching again", () => {
    const { view, finder } = setup("one two one two one");
    finder.find(query("one"));
    const marks = () =>
      [...view.contentDOM.querySelectorAll(".cm-find-match, .cm-find-current")].map((el) => `${el.className}`);
    expect(marks().filter((c) => c.includes("cm-find-current"))).toHaveLength(1);
    const search = vi.spyOn(SearchQuery.prototype, "getCursor");
    view.dispatch({ selection: { anchor: 8, head: 11 } });
    expect(search).not.toHaveBeenCalled();
    search.mockRestore();
    const current = view.contentDOM.querySelector(".cm-find-current");
    expect(current?.textContent).toBe("one");
    expect(view.posAtDOM(current!)).toBe(8);
    expect(view.contentDOM.querySelectorAll(".cm-find-match")).toHaveLength(2);
    // A selection that is no match leaves no current mark.
    view.dispatch({ selection: { anchor: 4, head: 7 } });
    expect(view.contentDOM.querySelectorAll(".cm-find-current")).toHaveLength(0);
    expect(view.contentDOM.querySelectorAll(".cm-find-match")).toHaveLength(3);
  });
});
