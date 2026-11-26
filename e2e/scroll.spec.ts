// Every tab keeps its own scroll position, and a file opened for the first time
// starts at the top instead of where the tab shown before it was scrolled to.
import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

const LONG = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const FILES = {
  "C:\\notes\\long.txt": LONG,
  "C:\\notes\\other.txt": LONG,
  "C:\\notes\\third.txt": LONG,
};

const scrollTop = (page: Page) => page.evaluate(() => window.e2e.view()!.scrollDOM.scrollTop);
const activeTitle = (page: Page) =>
  page.evaluate(() => {
    const s = window.e2e.state();
    return s.tabs.find((t) => t.id === s.activeId)?.title;
  });

async function openHere(page: Page, path: string, title: string): Promise<void> {
  await page.evaluate((p) => window.e2e.emit("open-paths-here", [p]), path);
  await expect.poll(() => activeTitle(page)).toBe(title);
  await page.waitForTimeout(150);
}

test("a newly opened file starts at the top; each tab keeps its own scroll", async ({ page }) => {
  await openApp(page, LONG, { files: FILES, open: ["C:\\notes\\long.txt"] });
  await page.evaluate(() => {
    window.e2e.view()!.scrollDOM.scrollTop = 2000;
  });
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);
  const kept = await scrollTop(page);

  await openHere(page, "C:\\notes\\other.txt", "other.txt");
  await expect.poll(() => scrollTop(page)).toBe(0);

  // Scrolled a little, then a third file: also from the top.
  await page.evaluate(() => {
    window.e2e.view()!.scrollDOM.scrollTop = 500;
  });
  await openHere(page, "C:\\notes\\third.txt", "third.txt");
  await expect.poll(() => scrollTop(page)).toBe(0);

  // Back to the first tabs: each where it was left.
  await page.locator(".tab-list [data-tab-id]").filter({ hasText: "long.txt" }).click();
  await expect.poll(() => scrollTop(page)).toBeCloseTo(kept, 0);
  await page.locator(".tab-list [data-tab-id]").filter({ hasText: "other.txt" }).click();
  await expect.poll(() => scrollTop(page)).toBeCloseTo(500, 0);
});

test("a new empty tab starts at the top too", async ({ page }) => {
  await openApp(page, LONG, { files: FILES, open: ["C:\\notes\\long.txt"] });
  await page.evaluate(() => {
    window.e2e.view()!.scrollDOM.scrollTop = 2000;
  });
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);
  await page.keyboard.press("Control+n");
  await expect.poll(() => page.evaluate(() => window.e2e.state().tabs.length)).toBe(2);
  await expect.poll(() => scrollTop(page)).toBe(0);
});
