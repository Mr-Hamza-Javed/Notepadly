// The find bar in a real browser: whole word, regular expressions, and matches inside
// rendered table cells (BUGS.md TAB-1).
import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

const TEXT = [
  "cat catalog cat. concat Cat",
  "",
  "| animal | note |",
  "| --- | --- |",
  "| cat | a cat sleeps |",
  "| dog | catalog item |",
  "",
  "item 12 and item 345",
  "",
].join("\n");

const count = (page: Page) => page.locator(".find-count");
const selected = (page: Page) =>
  page.evaluate(() => {
    const view = window.e2e.view()!;
    const { from, to } = view.state.selection.main;
    return view.state.sliceDoc(from, to);
  });

async function openFind(page: Page, query: string): Promise<void> {
  await page.keyboard.press("Control+f");
  const input = page.getByRole("textbox", { name: "Find" });
  await expect(input).toBeFocused();
  await input.fill(query);
}

test.beforeEach(async ({ page }) => {
  await openApp(page, TEXT);
  await expect(page.locator(".cm-md-table table")).toBeVisible();
});

test("plain search counts every match, in text and in table cells", async ({ page }) => {
  await openFind(page, "cat");
  // cat, catalog, cat., concat, Cat, cat, cat, catalog: case-insensitive by default.
  await expect(count(page)).toHaveText(/ of 8$/);
});

test("TAB-1: every match in a table cell is highlighted, not only the current one", async ({ page }) => {
  await openFind(page, "cat");
  await expect(count(page)).toHaveText(/ of 8$/);
  const cells = page.locator(".cm-md-table td");
  // "cat", "a cat sleeps", "catalog item": three cells, one mark each.
  await expect(page.locator(".cm-md-table mark")).toHaveCount(3);
  await expect(cells.filter({ hasText: "a cat sleeps" }).locator("mark")).toHaveText("cat");
  await expect(cells.filter({ hasText: "catalog item" }).locator("mark")).toHaveText("cat");
  // Matches outside the table are marked by the editor.
  expect(await page.locator(".cm-line .cm-find-match, .cm-line .cm-searchMatch").count()).toBeGreaterThanOrEqual(1);
  // Stepping to a match in a cell makes it the current (strong) mark.
  for (let i = 0; i < 6; i++) await page.getByRole("textbox", { name: "Find" }).press("Enter");
  await expect(page.locator(".cm-md-table mark.cm-md-cell-selection")).toHaveCount(1);
});

test("whole word skips cat inside other words", async ({ page }) => {
  await openFind(page, "cat");
  await page.getByRole("button", { name: "Match whole word" }).click();
  // cat, cat., Cat, and the two table cells.
  await expect(count(page)).toHaveText(/ of 5$/);
  await expect(page.locator(".cm-md-table mark")).toHaveCount(2);
  await page.getByRole("button", { name: "Match case" }).click();
  await expect(count(page)).toHaveText(/ of 4$/);
});

test("regular expressions match and select the found text", async ({ page }) => {
  await openFind(page, "item \\d+");
  await page.getByRole("button", { name: "Use regular expression" }).click();
  await expect(count(page)).toHaveText(/ of 2$/);
  await page.getByRole("textbox", { name: "Find" }).press("Enter");
  await expect.poll(() => selected(page)).toMatch(/^item \d+$/);
  // An invalid pattern finds nothing and does not throw.
  await page.getByRole("textbox", { name: "Find" }).fill("item (");
  await expect(count(page)).toContainText("Invalid");
  await expect(page.locator(".cm-md-table mark")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Find" }).fill("c[ao]t");
  await expect(count(page)).toHaveText(/ of 8$/);
});

test("closing the find bar removes the highlights from table cells", async ({ page }) => {
  await openFind(page, "cat");
  await expect(page.locator(".cm-md-table mark")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(page.locator(".findbar")).toHaveCount(0);
  await expect(page.locator(".cm-md-table mark.cm-find-match")).toHaveCount(0);
});
