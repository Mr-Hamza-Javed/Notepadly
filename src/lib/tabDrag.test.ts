// @vitest-environment jsdom
// Geometry of the tab drag gesture (F2): reorder, pull out, drop position.
import { describe, expect, it } from "vitest";
import { DETACH_DISTANCE, dropIndexAt, insertionIndex, isPulledOut, reorderTarget } from "./tabDrag";

const strip = { left: 40, top: 0, right: 800, bottom: 40 };
const view = { width: 1000, height: 700 };

describe("pulling a tab out of the strip", () => {
  it("stays a reorder while the pointer is on or near the strip", () => {
    expect(isPulledOut(strip, 300, 20, view)).toBe(false);
    expect(isPulledOut(strip, 300, strip.bottom + DETACH_DISTANCE, view)).toBe(false);
    // Sideways past the strip's end is still a reorder (it clamps to the last place).
    expect(isPulledOut(strip, 950, 20, view)).toBe(false);
  });

  it("pulls out when dragged well below or above the strip", () => {
    expect(isPulledOut(strip, 300, strip.bottom + DETACH_DISTANCE + 1, view)).toBe(true);
    expect(isPulledOut({ ...strip, top: 100, bottom: 140 }, 300, 100 - DETACH_DISTANCE - 1, view)).toBe(true);
  });

  it("pulls out whenever the pointer leaves the window", () => {
    expect(isPulledOut(strip, -1, 20, view)).toBe(true);
    expect(isPulledOut(strip, 300, -5, view)).toBe(true);
    expect(isPulledOut(strip, view.width, 20, view)).toBe(true);
  });
});

describe("reordering inside the strip", () => {
  const lefts = [0, 100, 200, 300];
  const widths = [100, 100, 100, 100];

  it("moves past a neighbour once the dragged tab's centre crosses its middle", () => {
    expect(reorderTarget(lefts, widths, 0, 99)).toBe(0);
    expect(reorderTarget(lefts, widths, 0, 100)).toBe(1);
    expect(reorderTarget(lefts, widths, 0, 300)).toBe(3);
    expect(reorderTarget(lefts, widths, 3, -150)).toBe(2);
    expect(reorderTarget(lefts, widths, 3, -300)).toBe(0);
  });
});

describe("dropping a tab on another window", () => {
  it("goes between the tabs it was dropped between", () => {
    expect(insertionIndex([50, 150, 250], 10)).toBe(0);
    expect(insertionIndex([50, 150, 250], 160)).toBe(2);
    expect(insertionIndex([50, 150, 250], 900)).toBe(3);
  });

  it("uses the tab bar of the page, and goes at the end when dropped elsewhere", () => {
    document.body.innerHTML = `<div class="titlebar"><div class="tab-list">
      <div data-tab-id="a"></div><div data-tab-id="b"></div></div></div>`;
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    (document.querySelector(".titlebar") as HTMLElement).getBoundingClientRect = () => rect(0, 0, 900, 40);
    const tabs = document.querySelectorAll<HTMLElement>("[data-tab-id]");
    tabs[0].getBoundingClientRect = () => rect(40, 0, 200, 40);
    tabs[1].getBoundingClientRect = () => rect(240, 0, 200, 40);
    expect(dropIndexAt(100, 20)).toBe(0);
    expect(dropIndexAt(200, 20)).toBe(1);
    expect(dropIndexAt(600, 20)).toBe(2);
    expect(dropIndexAt(200, 300)).toBeNull();
  });
});
