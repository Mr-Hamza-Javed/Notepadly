// Shared helpers for the end-to-end tests. The page is e2e/app.html: the real app
// over a fake Tauri backend (e2e/boot.ts).
import { expect, type Page } from "@playwright/test";
import type { E2eSeed } from "./seed";

export const DOC = "C:\\notes\\doc.md";

/** Boots the app with `text` open as C:\notes\doc.md (or the given seed) and waits for it. */
export async function openApp(page: Page, text: string, seed: E2eSeed = {}): Promise<void> {
  const full: E2eSeed = { ...seed, files: { [DOC]: text, ...seed.files }, open: seed.open ?? [DOC] };
  await page.addInitScript((s) => {
    (window as unknown as { __E2E_SEED__: E2eSeed }).__E2E_SEED__ = s;
  }, full);
  await page.goto("/e2e/app.html");
  await page.waitForFunction(
    (expected) => window.e2e?.view?.()?.state.doc.toString() === expected,
    text.replace(/\r\n?/g, "\n"),
  );
  // Live preview widgets render after the first measure.
  await page.waitForTimeout(150);
}

export const docText = (page: Page): Promise<string> => page.evaluate(() => window.e2e.view()!.state.doc.toString());

export const selection = (page: Page): Promise<{ anchor: number; head: number }> =>
  page.evaluate(() => {
    const main = window.e2e.view()!.state.selection.main;
    return { anchor: main.anchor, head: main.head };
  });

/** The cursor's line number (1-based) and column (0-based) in the editor. */
export const cursorLine = (page: Page): Promise<{ line: number; col: number }> =>
  page.evaluate(() => {
    const state = window.e2e.view()!.state;
    const line = state.doc.lineAt(state.selection.main.head);
    return { line: line.number, col: state.selection.main.head - line.from };
  });

/** Puts the editor cursor at a document offset and focuses the editor. */
export async function setCursor(page: Page, anchor: number, head = anchor): Promise<void> {
  await page.evaluate(
    ([a, h]) => {
      const view = window.e2e.view()!;
      view.dispatch({ selection: { anchor: a, head: h }, scrollIntoView: true });
      view.focus();
    },
    [anchor, head],
  );
}

/** Puts the cursor at the start of the first line equal to `text`. */
export async function cursorToLine(page: Page, text: string, atEnd = false): Promise<void> {
  const pos = await page.evaluate(
    ([t, end]) => {
      const doc = window.e2e.view()!.state.doc;
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (line.text === t) return end ? line.to : line.from;
      }
      throw new Error(`no line ${t}`);
    },
    [text, atEnd] as const,
  );
  await setCursor(page, pos);
}

/** True when the tab is marked unsaved. */
export const isDirty = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const s = window.e2e.state();
    return !!s.tabs.find((t) => t.id === s.activeId)?.dirty;
  });

/** The table cell that has focus, as row/col (row 0 is the header, body rows start at 2). */
export const focusedCell = (page: Page): Promise<{ row: number; col: number; text: string } | null> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const cell = el?.closest<HTMLElement>(".cm-md-table th, .cm-md-table td");
    return cell ? { row: Number(cell.dataset.row), col: Number(cell.dataset.col), text: cell.textContent ?? "" } : null;
  });

export async function expectText(page: Page, expected: string): Promise<void> {
  await expect.poll(() => docText(page)).toBe(expected);
}
