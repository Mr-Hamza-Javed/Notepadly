// Typing speed sanity in a 3,000-row table, with real layout. The bounds are generous
// (CI machines are slow, and this is the dev build); they catch a keystroke that redraws
// the whole table. Measured here: ~150 ms per key in a cell, ~60 ms in text below, each
// including the Playwright round trip; most of a cell key is Lezer re-parsing the table.
import { expect, test, type Page } from "@playwright/test";
import { docText, focusedCell, openApp } from "./fixtures";

const ROWS = 3000;
const TABLE =
  "Big table\n\n| id | name | note |\n| --- | --- | --- |\n" +
  Array.from({ length: ROWS }, (_v, i) => `| ${i} | name ${i} | some **bold** note ${i} |`).join("\n") +
  "\n\nafter\n";

/** Types `text` one key at a time; returns the slowest and the mean time per key, in ms. */
async function timeTyping(page: Page, text: string): Promise<{ max: number; mean: number }> {
  const times: number[] = [];
  for (const ch of text) {
    const start = Date.now();
    await page.keyboard.type(ch);
    // The key is done once the document has it and a frame has been drawn.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    times.push(Date.now() - start);
  }
  return { max: Math.max(...times), mean: times.reduce((a, b) => a + b, 0) / times.length };
}

test("typing in a cell of a 3,000-row table stays fast", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, TABLE);
  await expect(page.locator(".cm-md-table table")).toBeVisible();
  const cell = page.locator(".cm-md-table td").filter({ hasText: /^name 5$/ });
  await cell.click();
  await expect.poll(() => focusedCell(page)).toMatchObject({ text: "name 5" });
  await page.keyboard.press("End");
  const typed = "xxxxxxxxxxxxxxxxxxxx";
  const { max, mean } = await timeTyping(page, typed);
  console.log(`3,000-row table, cell typing: mean ${mean.toFixed(1)} ms, max ${max} ms per key`);
  expect((await docText(page)).split("\n")[9]).toBe(`| 5 | name 5${typed} | some **bold** note 5 |`);
  expect(mean).toBeLessThan(400);
  expect(max).toBeLessThan(2000);
});

test("typing in text after a 3,000-row table stays fast", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page, TABLE);
  await page.keyboard.press("Control+End");
  const typed = "yyyyyyyyyyyyyyyyyyyy";
  const { max, mean } = await timeTyping(page, typed);
  console.log(`3,000-row table, text typing: mean ${mean.toFixed(1)} ms, max ${max} ms per key`);
  expect(await docText(page)).toBe(TABLE + typed);
  expect(mean).toBeLessThan(400);
  expect(max).toBeLessThan(2000);
});
