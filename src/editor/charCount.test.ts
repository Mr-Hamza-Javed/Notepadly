// BUGS.md L5: the status bar counts characters as code points, so an emoji is one.
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { codePointLength, codePointsIn, countCodePoints, surrogatePairField, surrogatePairs } from "./charCount";

const stateOf = (doc: string) => EditorState.create({ doc, extensions: [surrogatePairField] });
const brute = (text: string) => [...text].length;

describe("code point counts", () => {
  it("counts an emoji once and a lone surrogate as one character", () => {
    expect(countCodePoints("a😀b")).toBe(3);
    expect(countCodePoints("👍🏽")).toBe(2);
    expect(countCodePoints("\uD83D")).toBe(1);
    expect(countCodePoints("\uDE00\uD83D")).toBe(2);
    expect(surrogatePairs("😀😀\n😀")).toBe(3);
  });

  it("keeps the document count right through edits, including ones that split or join a pair", () => {
    let state = stateOf("x😀y\n😀😀z");
    expect(codePointLength(state)).toBe(brute(state.doc.toString()));
    const edits = [
      { from: 2, to: 2, insert: "Q" }, // between the halves of a pair
      { from: 0, to: 0, insert: "\uD83D" }, // a high half before "x"
      { from: 1, to: 2, insert: "" }, // delete "x": the high half meets... nothing paired
      { from: 3, to: 4, insert: "\uDE00" }, // a low half after a high one
      { from: 0, to: 6, insert: "🎉\n" },
    ];
    for (const change of edits) {
      state = state.update({ changes: change }).state;
      expect(codePointLength(state)).toBe(brute(state.doc.toString()));
    }
  });

  it("matches a full recount after many random edits", () => {
    const pieces = ["a", "😀", "\n", "\uD83D", "\uDE00", "é", "🏽", ""];
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    let state = stateOf("😀abc\n😀");
    for (let i = 0; i < 500; i++) {
      const len = state.doc.length;
      const from = random(len + 1);
      const to = Math.min(len, from + random(4));
      const insert = pieces[random(pieces.length)] + pieces[random(pieces.length)];
      state = state.update({ changes: { from, to, insert } }).state;
      expect(codePointLength(state)).toBe(brute(state.doc.toString()));
    }
  });

  it("counts selections in code points", () => {
    const state = stateOf("ab😀cd");
    expect(codePointsIn(state, 0, state.doc.length)).toBe(5);
    expect(codePointsIn(state, 1, 5)).toBe(3);
    expect(codePointsIn(stateOf("plain"), 1, 4)).toBe(3);
    const selected = state.update({ selection: EditorSelection.range(2, 4) }).state.selection.main;
    expect(codePointsIn(state, selected.from, selected.to)).toBe(1);
  });
});
