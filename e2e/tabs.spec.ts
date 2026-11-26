// Dragging tabs: reordering inside the strip, and pulling a tab out of the window up
// to the IPC call that hands it to another window or a new one (BUGS.md F2). The
// other window is not there in one page, so its receipt is played back as an event.
import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

const FILES = { "C:\\notes\\a.md": "aaa\n", "C:\\notes\\b.md": "bbb\n", "C:\\notes\\c.md": "ccc\n" };
const OPEN = Object.keys(FILES);

const titles = (page: Page) => page.evaluate(() => window.e2e.state().tabs.map((t) => t.title));
const tab = (page: Page, title: string) => page.locator(".tab-list [data-tab-id]").filter({ hasText: title });

async function boot(page: Page, dropTarget: { label: string; x: number; y: number } | null = null) {
  await openApp(page, "ccc\n", { files: FILES, open: OPEN, dropTarget });
  await expect(page.locator(".tab-list [data-tab-id]")).toHaveCount(3);
  expect(await titles(page)).toEqual(["a.md", "b.md", "c.md"]);
}

/** Presses on a tab and moves the mouse in steps to (x, y). Leaves the button down. */
async function dragTab(page: Page, title: string, x: number, y: number): Promise<void> {
  const box = (await tab(page, title).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
}

test("dragging a tab along the strip reorders the tabs", async ({ page }) => {
  await boot(page);
  const last = (await tab(page, "c.md").boundingBox())!;
  await dragTab(page, "a.md", last.x + last.width - 4, last.y + last.height / 2);
  await expect(tab(page, "a.md")).toHaveClass(/dragging/);
  await page.mouse.up();
  await expect.poll(() => titles(page)).toEqual(["b.md", "c.md", "a.md"]);
  await expect(tab(page, "a.md")).not.toHaveClass(/dragging/);
  // No IPC: reordering stays in this window.
  expect(await page.evaluate(() => window.e2e.ipc.some((c) => c.cmd === "tab_drop_target"))).toBe(false);
});

test("Escape cancels a tab drag and leaves the order alone", async ({ page }) => {
  await boot(page);
  const last = (await tab(page, "c.md").boundingBox())!;
  await dragTab(page, "a.md", last.x + last.width - 4, last.y + last.height / 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await titles(page)).toEqual(["a.md", "b.md", "c.md"]);
  // The Escape went to the drag, not to anything else, and the tabs are all still open.
  await expect(page.locator(".tab-list [data-tab-id]")).toHaveCount(3);
});

test("F2: a tab pulled out of the strip is torn off at once into a new window that follows the mouse", async ({ page }) => {
  await boot(page);
  const before = (await tab(page, "c.md").boundingBox())!;
  // The button is still down: as in Chrome the window is made now, not on release.
  await dragTab(page, "b.md", 400, 400);
  await expect(tab(page, "b.md")).toHaveClass(/tab-detached/);
  // Its place closes up: c.md slides left into it.
  await expect.poll(async () => (await tab(page, "c.md").boundingBox())!.x).toBeLessThan(before.x - 100);
  const call = await expect
    .poll(() => page.evaluate(() => window.e2e.ipc.find((c) => c.cmd === "window_new")?.args ?? null))
    .not.toBeNull()
    .then(() => page.evaluate(() => window.e2e.ipc.find((c) => c.cmd === "window_new")!.args));
  expect(call).toMatchObject({ atCursor: true, follow: true });
  const transfer = JSON.parse(call.transfer as string) as {
    from: string;
    fromIndex: number;
    tab: { id: string; title: string; path: string };
  };
  expect(transfer).toMatchObject({ from: "main", fromIndex: 1, tab: { title: "b.md", path: "C:\\notes\\b.md" } });
  await page.mouse.up();
  // The tab is only removed once the new window confirms it has it.
  expect(await titles(page)).toEqual(["a.md", "b.md", "c.md"]);
  await page.evaluate((id) => window.e2e.emit("tab-received", { id }), transfer.tab.id);
  await expect.poll(() => titles(page)).toEqual(["a.md", "c.md"]);
});

test("F2: the only tab pulled out drags its own window", async ({ page }) => {
  await openApp(page, "only\n");
  await dragTab(page, "doc.md", 400, 400);
  await expect
    .poll(() => page.evaluate(() => window.e2e.ipc.some((c) => c.cmd === "window_drag_start")))
    .toBe(true);
  await page.mouse.up();
  expect(await page.evaluate(() => window.e2e.ipc.some((c) => c.cmd === "window_new"))).toBe(false);
  await expect(page.locator(".tab-list [data-tab-id]")).toHaveCount(1);
});

test("F2: tabs slide apart for a tab hovering from another window, and it drops into the gap", async ({ page }) => {
  await boot(page);
  const a = (await tab(page, "a.md").boundingBox())!;
  const b = (await tab(page, "b.md").boundingBox())!;
  // Rust reports the dragged tab over this strip, between a.md and b.md.
  await page.evaluate((x) => window.e2e.emit("tab-drag-hover", { x, y: 12 }), b.x + 10);
  await expect.poll(async () => (await tab(page, "b.md").boundingBox())!.x).toBeGreaterThan(b.x + b.width - 2);
  expect((await tab(page, "a.md").boundingBox())!.x).toBe(a.x);
  // It moves on past c.md: the gap follows.
  await page.evaluate(() => window.e2e.emit("tab-drag-hover", { x: 2000, y: 12 }));
  await expect.poll(async () => (await tab(page, "b.md").boundingBox())!.x).toBeCloseTo(b.x, 0);
  await page.evaluate((x) => window.e2e.emit("tab-drag-hover", { x, y: 12, title: "new.md", dirty: false }), b.x + 10);
  // The dragged tab shows here under the mouse, as in Chrome.
  await expect(page.locator(".tab-phantom")).toHaveText(/new.md/);
  // Dropped: the gap waits, then the tab arrives in it.
  await page.evaluate(() => window.e2e.emit("tab-drag-leave", { dropping: true }));
  const transfer = await page.evaluate(() => {
    const state = window.e2e.state();
    const tab = state.tabs[0];
    return {
      from: "w2",
      tab: { ...tab, id: "from-w2", title: "new.md", path: null },
      handoff: { text: "new text", snap: null, hasDraft: false, draftMeta: null, forceDirty: false },
    };
  });
  await page.evaluate((t) => window.e2e.emit("tab-incoming", { transfer: t, x: 0, y: 0 }), transfer);
  await expect.poll(() => titles(page)).toEqual(["a.md", "new.md", "b.md", "c.md"]);
  // The tab under the mouse becomes the real one, sliding into its place.
  await expect(page.locator(".tab-phantom")).toHaveCount(0);
  await expect.poll(async () => (await tab(page, "new.md").boundingBox())!.x).toBeCloseTo(b.x, 0);
});

test("F2: a tab hovering and leaving without a drop puts the tabs back", async ({ page }) => {
  await boot(page);
  const b = (await tab(page, "b.md").boundingBox())!;
  await page.evaluate((x) => window.e2e.emit("tab-drag-hover", { x, y: 12 }), b.x + 10);
  await expect.poll(async () => (await tab(page, "b.md").boundingBox())!.x).toBeGreaterThan(b.x + 50);
  await expect(page.locator(".tab-phantom")).toHaveCount(1);
  await page.evaluate(() => window.e2e.emit("tab-drag-leave", { dropping: false }));
  await expect.poll(async () => (await tab(page, "b.md").boundingBox())!.x).toBeCloseTo(b.x, 0);
  await expect(page.locator(".tab-phantom")).toHaveCount(0);
});
