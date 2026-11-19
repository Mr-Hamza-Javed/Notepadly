// Editing a rendered table in place: the cell's caret and selection are mirrored into
// the editor, so commands apply to the cell (BUGS.md H1, M1, M2).
import { expect, test, type Page } from "@playwright/test";
import { docText, expectText, focusedCell, openApp } from "./fixtures";

const TABLE = "Intro\n\n| fruit | n |\n| --- | --- |\n| apple pie | 2 |\n| kiwi | 3 |\n\nafter\n";
const row = async (page: Page, n: number) => (await docText(page)).split("\n")[n];

/** The editor's selected text and the browser's, which must agree in a cell. */
const selections = (page: Page) =>
  page.evaluate(() => {
    const view = window.e2e.view()!;
    const { from, to } = view.state.selection.main;
    return { editor: view.state.sliceDoc(from, to), dom: getSelection()?.toString() ?? "" };
  });

async function clickCell(page: Page, text: string): Promise<void> {
  await page.locator(".cm-md-table th, .cm-md-table td").filter({ hasText: text }).first().click();
  await expect.poll(() => focusedCell(page)).toMatchObject({ text });
}

test.beforeEach(async ({ page }) => {
  await openApp(page, TABLE);
  await expect(page.locator(".cm-md-table table")).toBeVisible();
});

test("H1: Ctrl+B and Ctrl+I wrap the text selected in a cell", async ({ page }) => {
  await clickCell(page, "apple pie");
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => selections(page)).toEqual({ editor: "apple", dom: "apple" });
  await page.keyboard.press("Control+b");
  await expect.poll(() => row(page, 4)).toBe("| **apple** pie | 2 |");
  // The cell keeps the selection on the word, so Ctrl+I wraps the same text.
  await expect.poll(() => selections(page)).toEqual({ editor: "apple", dom: "apple" });
  await page.keyboard.press("Control+i");
  await expect.poll(() => row(page, 4)).toBe("| ***apple*** pie | 2 |");
  // Undo in the cell undoes in the document.
  await page.keyboard.press("Control+z");
  await expect.poll(() => row(page, 4)).toBe("| **apple** pie | 2 |");
});

test("H1: the toolbar's Bold button applies to the cell selection", async ({ page }) => {
  await clickCell(page, "kiwi");
  await page.keyboard.press("Control+a");
  await page.getByRole("button", { name: "Bold (Ctrl+B)" }).click();
  await expect.poll(() => row(page, 5)).toBe("| **kiwi** | 3 |");
  await expect.poll(async () => (await focusedCell(page))?.row).toBe(3);
});

test("M1: Select All in a cell selects only the cell's text", async ({ page }) => {
  await clickCell(page, "apple pie");
  await page.keyboard.press("Control+a");
  await expect.poll(() => selections(page)).toEqual({ editor: "apple pie", dom: "apple pie" });
  await page.keyboard.type("pear");
  await expectText(page, TABLE.replace("apple pie", "pear"));
});

test("M2: F5 inserts the date at the cell caret, after a space typed there", async ({ page }) => {
  await clickCell(page, "kiwi");
  await page.keyboard.press("End");
  await page.keyboard.type(" due ");
  await page.keyboard.press("F5");
  // Was "| kiwi due4:49 PM 11/19/2026 | 3 |": the typed space was lost.
  await expect.poll(() => row(page, 5)).toMatch(/^\| kiwi due \d{1,2}:\d{2}.*\d{4} \| 3 \|$/);
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 3, col: 0 });
});

test("M2: pasting with Ctrl+V and with Edit > Paste cannot break the row", async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText("a|b\nc"));
  await clickCell(page, "kiwi");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+v");
  await expect.poll(() => row(page, 5)).toBe("| kiwia\\|b c | 3 |");
  await clickCell(page, "apple pie");
  await page.keyboard.press("Home");
  await page.locator(".menu-head[data-head=edit]").click();
  await page.getByRole("menuitem", { name: /^Paste/ }).click();
  await expect.poll(() => row(page, 4)).toBe("| a\\|b capple pie | 2 |");
  await expect.poll(() => docText(page).then((t) => t.split("\n").length)).toBe(TABLE.split("\n").length);
});

test("M2: Ctrl+K turns the cell selection into a link", async ({ page }) => {
  await clickCell(page, "apple pie");
  await page.keyboard.press("End");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => selections(page)).toEqual({ editor: "pie", dom: "pie" });
  await page.keyboard.press("Control+k");
  const url = page.locator("#link-url");
  await expect(url).toBeFocused();
  await expect(page.locator("#link-text")).toHaveValue("pie");
  await url.fill("https://example.com/x");
  await page.keyboard.press("Enter");
  await expect.poll(() => row(page, 4)).toBe("| apple [pie](https://example.com/x) | 2 |");
});

test("arrow keys move inside a cell first, then from cell to cell", async ({ page }) => {
  await clickCell(page, "kiwi");
  await page.keyboard.press("Home");
  // Right walks through "kiwi" before it leaves the cell.
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 3, col: 0 });
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 3, col: 1, text: "3" });
  // Left at the start of a cell goes to the end of the one before.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 3, col: 0 });
  await page.keyboard.type("s");
  await expect.poll(() => row(page, 5)).toBe("| kiwis | 3 |");
  // Up and Down change rows in the same column; Shift+arrows select in the cell.
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2, col: 0 });
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => selections(page)).toEqual({ editor: "pie", dom: "pie" });
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2, col: 0 });
  // Tab and Shift+Tab move along the row.
  await page.keyboard.press("Tab");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2, col: 1 });
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => focusedCell(page)).toMatchObject({ row: 2, col: 0 });
});

test("right-clicking a cell shows the table menu, not the page menu", async ({ page }) => {
  const prevented = await page.evaluate(() => {
    const cell = document.querySelector<HTMLElement>(".cm-md-table td")!;
    const r = cell.getBoundingClientRect();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 });
    cell.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: /insert row below/i }).click();
  await expect.poll(() => docText(page).then((t) => t.split("\n").length)).toBe(TABLE.split("\n").length + 1);
});
