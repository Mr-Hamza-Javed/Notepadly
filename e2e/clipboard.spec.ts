// Edit menu clipboard (M16, W2), dragging selected text (W1) and the right-click
// menu on rendered parts (W3), in a real browser with clipboard permissions granted.
import { expect, test, type Page } from "@playwright/test";
import { expectText, openApp, setCursor } from "./fixtures";

async function editMenu(page: Page, item: string): Promise<void> {
  await page.locator(".menu-head[data-head=edit]").click();
  await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe("Edit menu clipboard", () => {
  const TEXT = "alpha beta gamma\nsecond line\n";

  test.beforeEach(async ({ page }) => {
    await openApp(page, TEXT);
  });

  test("M16: Copy, Cut and Paste from the Edit menu", async ({ page }) => {
    await setCursor(page, 6, 10);
    await editMenu(page, "Copy");
    await expect.poll(() => clipboard(page)).toBe("beta");
    await expectText(page, TEXT);

    await page.evaluate(() => navigator.clipboard.writeText(""));
    await setCursor(page, 6, 11);
    await editMenu(page, "Cut");
    await expect.poll(() => clipboard(page)).toBe("beta ");
    await expectText(page, "alpha gamma\nsecond line\n");

    // Paste at the end of the second line; the editor has the keyboard again afterwards.
    await setCursor(page, "alpha gamma\nsecond line".length);
    await editMenu(page, "Paste");
    await expectText(page, "alpha gamma\nsecond linebeta \n");
    await page.keyboard.type("!");
    await expectText(page, "alpha gamma\nsecond linebeta !\n");
  });

  test("M16: Cut keeps the text and shows a message when the clipboard cannot be written", async ({ page }) => {
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("Clipboard write denied"));
    });
    await setCursor(page, 0, 5);
    await editMenu(page, "Cut");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Clipboard write denied");
    await expectText(page, TEXT);
  });

  test("W2: Paste with an empty selection inserts at the cursor without a prompt", async ({ page }) => {
    await page.evaluate(() => navigator.clipboard.writeText("XY"));
    await setCursor(page, 5);
    await editMenu(page, "Paste");
    await expectText(page, "alphaXY beta gamma\nsecond line\n");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Cut and Copy are disabled without a selection", async ({ page }) => {
    await setCursor(page, 3);
    await page.locator(".menu-head[data-head=edit]").click();
    await expect(page.getByRole("menuitem", { name: /^Cut/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("menuitem", { name: /^Copy/ })).toHaveAttribute("aria-disabled", "true");
  });
});

test("W1: selected text can be dragged to another place in the editor", async ({ page }) => {
  await openApp(page, "alpha beta gamma\n\nsecond line here\n");
  await setCursor(page, 6, 10);
  const points = await page.evaluate(() => {
    const view = window.e2e.view()!;
    const from = view.coordsAtPos(7)!;
    const to = view.coordsAtPos("alpha beta gamma\n\nsecond ".length)!;
    return { ax: from.left + 2, ay: (from.top + from.bottom) / 2, bx: to.left, by: (to.top + to.bottom) / 2 };
  });
  await page.mouse.move(points.ax, points.ay);
  await page.mouse.down();
  await page.mouse.move(points.ax + 10, points.ay + 4, { steps: 5 });
  await page.mouse.move(points.bx, points.by, { steps: 10 });
  await page.mouse.up();
  await expectText(page, "alpha  gamma\n\nsecond betaline here\n");
});

test.describe("W3: right-click on rendered parts", () => {
  const RENDERED = [
    "Text with a [ ] box",
    "",
    "- [ ] task",
    "",
    "---",
    "",
    "$$",
    "x^2",
    "$$",
    "",
    "![dot](data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=)",
    "",
    "```mermaid",
    "graph TD",
    "  A-->B",
    "```",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "end",
    "",
  ].join("\n");

  /** Right-clicks an element; true when the page's own menu was prevented. */
  const rightClick = (page: Page, selector: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`no ${sel}`);
      const r = el.getBoundingClientRect();
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: r.left + Math.min(4, r.width / 2),
        clientY: r.top + Math.min(4, r.height / 2),
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, selector);

  test.beforeEach(async ({ page }) => {
    await openApp(page, RENDERED);
    await expect(page.locator(".cm-md-mermaid svg")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".cm-md-math-block .katex")).toBeVisible();
  });

  for (const [name, selector] of [
    ["a maths block", ".cm-md-math-block .katex"],
    ["a diagram", ".cm-md-mermaid svg"],
    ["an image", ".cm-content img"],
    ["a task checkbox", ".cm-content input[type=checkbox], .cm-content .cm-md-checkbox"],
    ["a horizontal rule", ".cm-content .cm-md-hr, .cm-content hr"],
    ["a table border", ".cm-md-table table"],
  ] as const) {
    test(`the page menu is prevented on ${name}`, async ({ page }) => {
      expect(await rightClick(page, selector)).toBe(true);
    });
  }

  test("plain text keeps the WebView's text menu (Cut, Copy, Paste)", async ({ page }) => {
    expect(await rightClick(page, ".cm-line")).toBe(false);
  });
});
