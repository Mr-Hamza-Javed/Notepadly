import { describe, expect, it } from "vitest";
import { FIND_COUNT_LIMIT } from "../editor/find";
import { findCountLabel, findStep, setFindStepHandler } from "./findBar";

describe("find bar counter", () => {
  it("shows the index and total", () => {
    expect(findCountLabel({ total: 0, current: 0 })).toBe("No results");
    expect(findCountLabel({ total: 50, current: 3 })).toBe("3 of 50");
    expect(findCountLabel({ total: 1234, current: 1000 })).toBe("1,000 of 1,234");
  });

  // BUGS.md H10 (part 3): the total stops at the counting limit, so it is a lower bound.
  it("marks a total at the counting limit as a lower bound", () => {
    expect(findCountLabel({ total: FIND_COUNT_LIMIT, current: 1 })).toBe("1 of 10,000+");
    expect(findCountLabel({ total: FIND_COUNT_LIMIT, current: 0 })).toBe("10,000+ results");
  });

  it("shows a running count, and an invalid regular expression", () => {
    expect(findCountLabel({ total: 0, current: 0, pending: true })).toBe("Searching…");
    expect(findCountLabel({ total: 12, current: 1, pending: true })).toBe("1 of 12+");
    expect(findCountLabel({ total: 0, current: 0, invalid: true })).toBe("Invalid expression");
  });

  it("routes F3 steps to the mounted find bar only", () => {
    expect(findStep(1)).toBe(false);
    const steps: number[] = [];
    setFindStepHandler((dir) => steps.push(dir));
    expect(findStep(-1)).toBe(true);
    setFindStepHandler(null);
    expect(findStep(1)).toBe(false);
    expect(steps).toEqual([-1]);
  });
});
