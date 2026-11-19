import { expect, test } from "@playwright/test";
import { docText, openApp } from "./fixtures";

test("the app boots over the fake backend and opens a file", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openApp(page, "# Hello\n\nWorld\n");
  await expect(page.locator(".tab-list [data-tab-id]")).toHaveCount(1);
  await expect(page.locator(".tab-list")).toContainText("doc.md");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("typed");
  await expect.poll(() => docText(page)).toBe("# Hello\n\nWorld\ntyped");
  expect(errors).toEqual([]);
});
