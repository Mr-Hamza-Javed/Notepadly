// Geometry of dragging a tab: reordering inside the strip, pulling it out of the
// window (F2), and where a tab dropped on another window's tab bar goes.

/**
 * True while a tab is being dragged. The drag's own Escape handler cancels it,
 * so the global shortcuts must leave that Escape alone (BUGS.md UI-13).
 */
let tabDragging = false;

export const isTabDragging = (): boolean => tabDragging;

export function setTabDragging(dragging: boolean): void {
  tabDragging = dragging;
}

/**
 * What the tab strip hears about tabs dragged between windows (F2):
 * - `hover`: a tab dragged in another window has snapped into this strip: the mouse
 *   is at (x, y), CSS px, and holds the tab `grabX` px right of its own window's
 *   first tab, so the strip can show it there (`title`, `dirty`);
 * - `leave`: it left, or was dropped here (`dropping`), so the gap waits for it;
 * - `arrived`: a moved tab was added here; `stay`: a tab torn out of here could not go.
 */
export type TabStripNews =
  | { kind: "hover"; x: number; y: number; title?: string; dirty?: boolean; grabX?: number }
  | { kind: "leave"; dropping: boolean }
  | { kind: "arrived"; id: string }
  | { kind: "stay"; id: string };

const stripListeners = new Set<(news: TabStripNews) => void>();

export function announceTabStrip(news: TabStripNews): void {
  for (const listener of stripListeners) listener(news);
}

/** Listens for TabStripNews; returns the unsubscribe. */
export function onTabStripNews(listener: (news: TabStripNews) => void): () => void {
  stripListeners.add(listener);
  return () => stripListeners.delete(listener);
}

/** Where the strip holds a gap open for a hovering tab, or null. */
let hoverGap: number | null = null;

export const hoverGapIndex = (): number | null => hoverGap;

export function setHoverGapIndex(index: number | null): void {
  hoverGap = index;
}

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
