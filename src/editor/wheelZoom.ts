// Ctrl+wheel zoom in steps of one mouse-wheel notch, whatever the device sends.

/** What one notch of a mouse wheel scrolls, in pixels (Chromium's usual delta). */
const NOTCH_PX = 100;
/** A wheel that reports lines usually sends three per notch. */
const LINE_PX = NOTCH_PX / 3;
/** A pause this long ends a gesture and drops what it had gathered. */
const GESTURE_GAP_MS = 400;

/**
 * Returns a wheel handler that calls `onStep(+1)` (zoom in) or `onStep(-1)` once for each
 * notch's worth of Ctrl+wheel movement. A touchpad or pinch sends many small events; zooming
 * once per event made a pinch jump by hundreds of percent. Returns false for a wheel event
 * without Ctrl, which it leaves alone.
 */
export function wheelZoomHandler(onStep: (direction: 1 | -1) => void): (event: WheelEvent) => boolean {
  let gathered = 0;
  let lastTime = -Infinity;
  return (event) => {
    if (!event.ctrlKey) return false;
    event.preventDefault();
    const px =
      event.deltaMode === 1 ? event.deltaY * LINE_PX : event.deltaMode === 2 ? event.deltaY * NOTCH_PX : event.deltaY;
    if (px === 0) return true;
    const now = event.timeStamp || performance.now();
    // A new gesture, or a change of direction, starts again from zero.
    if (now - lastTime > GESTURE_GAP_MS || Math.sign(px) !== Math.sign(gathered)) gathered = 0;
    lastTime = now;
    gathered += px;
    while (Math.abs(gathered) >= NOTCH_PX) {
      const down = gathered > 0;
      onStep(down ? -1 : 1);
      gathered += down ? -NOTCH_PX : NOTCH_PX;
    }
    return true;
  };
}
