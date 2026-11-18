// @vitest-environment jsdom
// Edit > Cut / Copy / Paste go through the async clipboard API, which can fail.
import { bootApp, settle, type App } from "../test/appHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

let app: App;
let clipboard: { text: string; fail: boolean };

beforeEach(async () => {
  clipboard = { text: "", fail: false };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (clipboard.fail) throw new Error("Clipboard is busy");
        clipboard.text = text;
      },
      readText: async () => {
        if (clipboard.fail) throw new Error("Clipboard is busy");
        return clipboard.text;
      },
    },
  });
  app = await bootApp();
  app.type("keep this");
  app.engine.selectAll();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("clipboard commands", () => {
  it("Cut moves the selection to the clipboard", async () => {
    await app.actions.clipboard("cut");
    expect(clipboard.text).toBe("keep this");
    expect(app.text()).toBe("");
  });

  // BUGS.md M16: Cut deleted the text even when the clipboard write failed.
  it("M16: Cut keeps the text and says so when the clipboard cannot be written", async () => {
    clipboard.fail = true;
    await app.actions.clipboard("cut");
    await settle();
    expect(app.text()).toBe("keep this");
    expect(app.message()?.title).toBe("Could not copy to the clipboard");
  });

  it("M16: a failed paste is reported instead of doing nothing silently", async () => {
    clipboard.fail = true;
    await app.actions.clipboard("paste");
    await settle();
    expect(app.text()).toBe("keep this");
    expect(app.message()?.title).toBe("Could not paste");
  });

  it("Paste replaces the selection with the clipboard text", async () => {
    clipboard.text = "new";
    await app.actions.clipboard("paste");
    expect(app.text()).toBe("new");
  });
});
