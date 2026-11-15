// Fills the layout APIs jsdom lacks so a real CodeMirror EditorView can run in tests.
// Import this first in any test file that uses `// @vitest-environment jsdom`.

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }

  const emptyRect = (): DOMRect =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const emptyList = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = emptyRect;

  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

export {};
