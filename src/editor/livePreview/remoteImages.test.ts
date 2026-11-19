// @vitest-environment jsdom
// Settings > Load remote images: http(s) images wait for a click unless allowed.
import { mountEngine } from "../../test/editorHarness";
import { beforeEach, describe, expect, it } from "vitest";
import { engine } from "..";
import { dropRemoteImages } from "../../lib/print";
import { sanitizeSettings } from "../../state/logic";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const DOC = "![logo](https://example.com/a.png)\n\n![other](https://example.com/b.png)\n\n![local](pic.png)\n\nend";
const TABLE = "| a | b |\n| - | - |\n| ![t](https://example.com/t.png) | x |\n\nend";

function open(text: string, policy: "always" | "ask" | "never", id = "t"): void {
  engine.setConfig({ remoteImages: policy });
  engine.createDoc(id, text, "formatted");
  engine.activate(id);
  engine.restore(id, { anchor: text.length, head: text.length, scrollTop: 0 });
}

const placeholders = () => Array.from(document.querySelectorAll<HTMLElement>(".cm-md-image-blocked"));
const remoteImgs = () =>
  Array.from(document.querySelectorAll<HTMLImageElement>("img")).filter((img) => /^https?:/.test(img.getAttribute("src") ?? ""));
const press = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));

describe("Load remote images", () => {
  beforeEach(() => {
    mountEngine();
  });

  it("is 'Always' by default (as before the setting existed) and kept as stored", () => {
    expect(sanitizeSettings({}).remoteImages).toBe("always");
    expect(sanitizeSettings({ remoteImages: "never" }).remoteImages).toBe("never");
    expect(sanitizeSettings({ remoteImages: "sometimes" }).remoteImages).toBe("always");
  });

  it("'Always' loads web images at once", async () => {
    open(DOC, "always");
    await tick();
    expect(placeholders()).toHaveLength(0);
    expect(remoteImgs().map((img) => img.alt)).toEqual(["logo", "other"]);
  });

  it("'Ask' shows a placeholder, and a click loads every web image of that document only", async () => {
    open(DOC, "ask");
    await tick();
    expect(remoteImgs()).toHaveLength(0);
    expect(placeholders().map((p) => p.textContent)).toEqual([
      "Remote image blocked — click to load",
      "Remote image blocked — click to load",
    ]);
    // A local image is not affected.
    expect(document.querySelector("img[alt='local']")).not.toBeNull();
    expect(engine.remoteImageAllowed?.("t", "https://example.com/a.png")).toBe(false);
    press(placeholders()[0]);
    await tick();
    expect(placeholders()).toHaveLength(0);
    expect(remoteImgs().map((img) => img.getAttribute("src"))).toEqual([
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
    expect(engine.remoteImageAllowed?.("t", "https://example.com/zzz.png")).toBe(true);
    // Another document still asks.
    open(DOC, "ask", "u");
    await tick();
    expect(placeholders()).toHaveLength(2);
  });

  it("'Never' loads only the image clicked", async () => {
    open(DOC, "never");
    await tick();
    press(placeholders()[1]);
    await tick();
    expect(remoteImgs().map((img) => img.alt)).toEqual(["other"]);
    expect(placeholders()).toHaveLength(1);
  });

  it("changing the setting redraws the open document", async () => {
    open(DOC, "ask");
    await tick();
    expect(placeholders()).toHaveLength(2);
    engine.setConfig({ remoteImages: "always" });
    await tick();
    expect(placeholders()).toHaveLength(0);
    expect(remoteImgs()).toHaveLength(2);
  });

  it("table cells show the placeholder too, and a click loads the image instead of editing", async () => {
    open(TABLE, "ask");
    await tick();
    const [blocked] = placeholders();
    expect(blocked?.closest("td")).not.toBeNull();
    expect(remoteImgs()).toHaveLength(0);
    press(blocked);
    await tick();
    expect(document.querySelector(".cm-md-table .is-editing")).toBeNull();
    expect(remoteImgs().map((img) => img.getAttribute("src"))).toEqual(["https://example.com/t.png"]);
  });

  it("print leaves out web images that are not allowed, keeping their alt text", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p><img src="https://a.b/x.png" alt="web"><img src="https://a.b/ok.png" alt="ok"><img src="data:image/png;base64,AA" alt="inline"></p>';
    dropRemoteImages(root, (src) => src.endsWith("ok.png"));
    expect(Array.from(root.querySelectorAll("img")).map((img) => img.alt)).toEqual(["ok", "inline"]);
    expect(root.textContent).toBe("web");
  });
});
