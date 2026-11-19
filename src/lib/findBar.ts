// Glue between the find bar and global shortcuts, plus its counter text.
import type { FindResult } from "../editor/api";
import { FIND_COUNT_LIMIT } from "../editor/find";

type StepHandler = (dir: 1 | -1) => void;

let stepHandler: StepHandler | null = null;

/** The open find bar registers here, so F3 / Shift+F3 also update its counter. */
export function setFindStepHandler(handler: StepHandler | null): void {
  stepHandler = handler;
}

/** Runs Next/Previous through the find bar; false when no find bar is mounted. */
export function findStep(dir: 1 | -1): boolean {
  if (!stepHandler) return false;
  stepHandler(dir);
  return true;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** "3 of 50"; at the counting bound the total is a lower bound: "3 of 10,000+". */
export function findCountLabel(result: FindResult): string {
  if (result.total === 0) return "No results";
  const total = result.total >= FIND_COUNT_LIMIT ? `${fmt(FIND_COUNT_LIMIT)}+` : fmt(result.total);
  return result.current > 0 ? `${fmt(result.current)} of ${total}` : `${total} results`;
}
