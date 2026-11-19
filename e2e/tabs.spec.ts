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

test("F2: a tab pulled out of the window goes to a new window through window_new", async ({ page }) => {
  await boot(page);
  await dragTab(page, "b.md", 400, 400);
  await expect(tab(page, "b.md")).toHaveClass(/detaching/);
  await page.mouse.up();
  const call = await expect
    .poll(() => page.evaluate(() => window.e2e.ipc.find((c) => c.cmd === "window_new")?.args ?? null))
    .not.toBeNull()
    .then(() => page.evaluate(() => window.e2e.ipc.find((c) => c.cmd === "window_new")!.args));
  expect(call.atCursor).toBe(true);
  const transfer = JSON.parse(call.transfer as string) as { from: string; tab: { id: string; title: string; path: string } };
  expect(transfer.from).toBe("main");
  expect(transfer.tab.title).toBe("b.md");
  expect(transfer.tab.path).toBe("C:\\notes\\b.md");
  // The tab stays until the new window confirms it has it.
  expect(await titles(page)).toEqual(["a.md", "b.md", "c.md"]);
  await page.evaluate((id) => window.e2e.emit("tab-received", { id }), transfer.tab.id);
  await expect.poll(() => titles(page)).toEqual(["a.md", "c.md"]);
});

test("F2: a tab dropped on another window's tab bar is sent to that window", async ({ page }) => {
  await boot(page, { label: "w2", x: 120, y: 10 });
  await dragTab(page, "a.md", 600, 500);
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.e2e.ipc.some((c) => c.cmd === "plugin:event|emit_to")))
    .toBe(true);
  const sent = await page.evaluate(() => window.e2e.ipc.find((c) => c.cmd === "plugin:event|emit_to")!.args);
  expect(sent.event).toBe("tab-incoming");
  expect(sent.target).toMatchObject({ label: "w2" });
  const payload = sent.payload as { x: number; y: number; transfer: { tab: { id: string; title: string } } };
  expect(payload).toMatchObject({ x: 120, y: 10 });
  expect(payload.transfer.tab.title).toBe("a.md");
  expect(await page.evaluate(() => window.e2e.ipc.some((c) => c.cmd === "window_new"))).toBe(false);
  await page.evaluate((id) => window.e2e.emit("tab-received", { id }), payload.transfer.tab.id);
  await expect.poll(() => titles(page)).toEqual(["b.md", "c.md"]);
});
