// Geometry of dragging a tab: reordering inside the strip, pulling it out of the
// window (F2), and where a tab dropped on another window's tab bar goes.

/** How far past the tab strip, up or down, the pointer must go to pull a tab out. */
export const DETACH_DISTANCE = 32;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * True when the pointer is far enough from the tab strip that dropping now
 * moves the tab to another window (or a new one) instead of reordering it.
 */
export function isPulledOut(strip: Box, x: number, y: number, view: { width: number; height: number }): boolean {
  if (x < 0 || y < 0 || x >= view.width || y >= view.height) return true;
  return y < strip.top - DETACH_DISTANCE || y > strip.bottom + DETACH_DISTANCE;
}

/** Where a tab dropped at `x` goes between tabs whose centres are `centers` (left to right). */
export function insertionIndex(centers: number[], x: number): number {
  return centers.filter((center) => center < x).length;
}

/**
 * Index for a tab dropped at (x, y) in this window: by position when dropped on
 * the tab bar, otherwise null (it goes at the end).
 */
export function dropIndexAt(x: number, y: number, doc: Document = document): number | null {
  const bar = doc.querySelector(".titlebar")?.getBoundingClientRect();
  if (!bar || y < bar.top || y > bar.bottom) return null;
  const centers = Array.from(doc.querySelectorAll<HTMLElement>(".tab-list [data-tab-id]")).map((el) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  });
  return insertionIndex(centers, x);
}

/**
 * Reorder target while dragging inside the strip. `lefts`/`widths` are the tabs'
 * positions when the drag started, `dx` how far the dragged tab moved.
 */
export function reorderTarget(lefts: number[], widths: number[], index: number, dx: number): number {
  const center = lefts[index] + dx + widths[index] / 2;
  let target = index;
  for (let i = 0; i < lefts.length; i++) {
    if (i === index) continue;
    const mid = lefts[i] + widths[i] / 2;
    // Inclusive: dragging past the end clamps the centre onto the last tab's midpoint.
    if (i > index && center >= mid) target = Math.max(target, i);
    if (i < index && center <= mid) target = Math.min(target, i);
  }
  return target;
}
