// Cursor movement with the arrow keys across rendered tables, maths and Mermaid
// blocks, with real layout (BUGS.md H2, H3, M5).
import { expect, test, type Page } from "@playwright/test";
import { cursorLine, cursorToLine, expectText, focusedCell, isDirty, openApp } from "./fixtures";

const DOC_TEXT = [
  "Intro line", // 1
  "| A | B |", // 2
  "| - | - |",
  "| 1 | 2 |",
  "| 3 | 4 |", // 5
  "",
  "After table", // 7
  "",
  "$$", // 9
  "x^2 + y^2", // 10
  "$$",
  "",
  "After math", // 13
  "",
  "```mermaid", // 15
  "graph TD", // 16
  "  A-->B", // 17
  "```",
  "",
  "End line", // 20
  "",
].join("\n");

/** Is the maths block / diagram rendered (true) or open as source (false)? */
const mathRendered = (page: Page) => page.locator(".cm-md-math-block").count().then((n) => n > 0);
const diagramRendered = (page: Page) => page.locator(".cm-md-mermaid").count().then((n) => n > 0);
const line = async (page: Page) => (await cursorLine(page)).line;

test.describe("arrow keys across rendered blocks", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, DOC_TEXT);
    await expect(page.locator(".cm-md-table table")).toBeVisible();
    await expect(page.locator(".cm-md-math-block .katex")).toBeVisible();
    await expect(page.locator(".cm-md-mermaid svg")).toBeVisible({ timeout: 20_000 });
  });

  test("Down from the line above walks into the table, through its rows and out below", async ({ page }) => {
    await cursorToLine(page, "Intro line");
    await page.keyboard.press("ArrowDown");
    // Was: the table was skipped and the cursor landed on the blank line below it.
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 0, col: 0, text: "A" });
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2, col: 0, text: "1" });
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 3, col: 0, text: "3" });
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => focusedCell(page)).toBeNull();
    expect(await line(page)).toBe(6);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("!");
    await expectText(page, DOC_TEXT.replace("After table", "!After table"));
  });

  test("Up from below walks into the table's last row, through it and out above", async ({ page }) => {
    await cursorToLine(page, "After table");
    await page.keyboard.press("ArrowUp");
    expect(await line(page)).toBe(6);
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 3 });
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2 });
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 0 });
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => focusedCell(page)).toBeNull();
    expect(await line(page)).toBe(1);
    expect(await isDirty(page)).toBe(false);
  });

  test("Right and Left cross the table cell by cell", async ({ page }) => {
    await cursorToLine(page, "Intro line", true);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 0, col: 0 });
    // The caret is at the start of "A": past it, then into the next cell.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 0, col: 1 });
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => focusedCell(page)).toMatchObject({ row: 0, col: 0 });
    // Back into "A" at its end, then before it, then out of the table.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => focusedCell(page)).toBeNull();
    expect(await cursorLine(page)).toEqual({ line: 1, col: "Intro line".length });
    expect(await isDirty(page)).toBe(false);
  });

  test("Down from the line above a maths block opens it on the formula", async ({ page }) => {
    await cursorToLine(page, "After table");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    // Was: the block was skipped and the cursor landed below it.
    await expect.poll(() => line(page)).toBe(10);
    expect(await mathRendered(page)).toBe(false);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => line(page)).toBe(13);
    // Leaving the source renders it again.
    await expect.poll(() => mathRendered(page)).toBe(true);
    expect(await isDirty(page)).toBe(false);
  });

  test("Up from the line below a maths block opens it at the end of the formula", async ({ page }) => {
    await cursorToLine(page, "After math");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => cursorLine(page)).toEqual({ line: 10, col: "x^2 + y^2".length });
    await page.keyboard.type(" = r^2");
    await expectText(page, DOC_TEXT.replace("x^2 + y^2", "x^2 + y^2 = r^2"));
  });

  test("Right from the line above opens a maths block on the formula", async ({ page }) => {
    await cursorToLine(page, "After table", true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => cursorLine(page)).toEqual({ line: 10, col: 0 });
    expect(await mathRendered(page)).toBe(false);
  });

  test("Down and Up open a Mermaid diagram's code from either side", async ({ page }) => {
    await cursorToLine(page, "After math");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => line(page)).toBe(16);
    expect(await diagramRendered(page)).toBe(false);
    await cursorToLine(page, "End line");
    await expect.poll(() => diagramRendered(page)).toBe(true);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => cursorLine(page)).toEqual({ line: 17, col: "  A-->B".length });
    expect(await isDirty(page)).toBe(false);
  });
});

test("H3: Up in the header of a table at the top of the document stays in the cell", async ({ page }) => {
  const text = "| A | B |\n| - | - |\n| 1 | 2 |\n\nBelow\n";
  await openApp(page, text);
  await cursorToLine(page, "Below");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2 });
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 0, col: 1 });
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 0, col: 1 });
  await page.keyboard.press("Home");
  await page.keyboard.type("Z");
  await expectText(page, "| A | ZB |\n| - | - |\n| 1 | 2 |\n\nBelow\n");
});

test("M5: Down in the last row at the end stays in the cell; Escape then typing writes a paragraph", async ({ page }) => {
  const text = "Top\n| A | B |\n| - | - |\n| 1 | 2 |";
  await openApp(page, text);
  await cursorToLine(page, "Top");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2, col: 0 });
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2, col: 0 });
  expect(await isDirty(page)).toBe(false);
  // Escape lands below the table, outside the undo history.
  await page.keyboard.press("Escape");
  await expect.poll(() => focusedCell(page)).toBeNull();
  await expectText(page, text + "\n\n");
  expect(await isDirty(page)).toBe(false);
  // Was: the line was right under the table, so "a" made a table row and "fter" went to
  // the start of the document.
  await page.keyboard.type("after");
  await expectText(page, text + "\n\nafter");
  await expect(page.locator(".cm-md-table td")).toHaveCount(2);
});

test("typing on the empty last line right under a table stays where it is typed", async ({ page }) => {
  const text = "Top\n\n| A | B |\n| - | - |\n| 1 | 2 |\n";
  await openApp(page, text);
  await page.keyboard.press("Control+End");
  // GFM makes the typed line a table row; the rest of the word follows it into the new cell.
  await page.keyboard.type("after");
  await expectText(page, "Top\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| after |   |");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 3, col: 0, text: "after" });
});
