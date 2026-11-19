// Character counts in code points, as the status bar shows them (BUGS.md L5).
// CodeMirror positions are UTF-16 units, so an emoji is 2 there. Each document
// keeps its number of surrogate pairs up to date per change, so the count never
// rescans the whole text.
import { StateField, type EditorState, type Text } from "@codemirror/state";

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** Surrogate pairs (characters outside the Basic Multilingual Plane) in a string. */
export function surrogatePairs(text: string): number {
  let pairs = 0;
  for (let i = 0; i + 1 < text.length; i++) {
    if (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1))) {
      pairs++;
      i++;
    }
  }
  return pairs;
}

/** The number of characters (code points) in a string: an emoji counts once. */
export const countCodePoints = (text: string): number => text.length - surrogatePairs(text);

/**
 * Pairs whose first half lies in [from, to). A pair never spans a line break,
 * and `iterRange` only splits text at line breaks and at the range ends.
 */
function pairsStartingIn(doc: Text, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(doc.length, to + 1);
  if (start >= Math.min(doc.length, to)) return 0;
  let pairs = 0;
  for (let it = doc.iterRange(start, end); !it.next().done; ) pairs += surrogatePairs(it.value);
  return pairs;
}

function pairsInDoc(doc: Text): number {
  let pairs = 0;
  for (let it = doc.iter(); !it.next().done; ) pairs += surrogatePairs(it.value);
  return pairs;
}

/** Surrogate pairs in the document, updated from each change's edges only. */
export const surrogatePairField = StateField.define<number>({
  create: (state) => pairsInDoc(state.doc),
  update(pairs, tr) {
    if (!tr.docChanged) return pairs;
    // A pair starting just before a change can be cut or completed by it.
    tr.changes.iterChanges((fromA, toA, fromB, toB) => {
      pairs -= pairsStartingIn(tr.startState.doc, fromA - 1, toA);
      pairs += pairsStartingIn(tr.newDoc, fromB - 1, toB);
    });
    return pairs;
  },
});

/** The document's length in code points. */
export function codePointLength(state: EditorState): number {
  return state.doc.length - (state.field(surrogatePairField, false) ?? 0);
}

/** Above this many selected units the selection is counted in units when the document has pairs. */
const SELECTION_SCAN_LIMIT = 4_000_000;

/** Code points in [from, to): exact, except for a huge partial selection of a document with emoji. */
export function codePointsIn(state: EditorState, from: number, to: number): number {
  const total = state.field(surrogatePairField, false) ?? 0;
  if (total === 0 || to <= from) return Math.max(0, to - from);
  if (from === 0 && to === state.doc.length) return codePointLength(state);
  if (to - from > SELECTION_SCAN_LIMIT) return to - from;
  let pairs = 0;
  for (let it = state.doc.iterRange(from, to); !it.next().done; ) pairs += surrogatePairs(it.value);
  return to - from - pairs;
}
