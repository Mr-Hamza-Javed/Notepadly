// @vitest-environment jsdom
// BUGS.md L5: "characters" in the status bar counted UTF-16 units, so an emoji was 2.
import { bootApp, waitFor, type App } from "../test/appHarness";
import { backend } from "../test/fakeTauri";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

const BIG = "C:\\data\\emoji.log";
const line = "smile 😀 wave 👋🏽 ok\n";
const big = line.repeat(120_000); // ~3 MB: loads in parts

let app: App;

describe("L5: characters are counted as code points", () => {
  beforeEach(async () => {
    app = await bootApp();
  });

  it("a partly loaded file with emoji totals its code points", async () => {
    backend.write(BIG, big);
    await app.actions.openPaths([BIG]);
    await waitFor(() => app.tab().tailChars !== null);
    expect(app.tab().fullyLoaded).toBe(false);
    const id = app.tab().id;
    const total = () => app.engine.charCount(id) + app.tab().tailChars!;
    expect(total()).toBe([...big].length);
    app.type("😀");
    expect(total()).toBe([...big].length + 1);
    const before = app.tab().loadedOffset;
    app.loader.onNearEnd(id);
    await waitFor(() => app.tab().loadedOffset > before);
    expect(total()).toBe([...big].length + 1);
  });

  it("a small file counts each emoji once", async () => {
    backend.write("C:\\data\\small.txt", "a😀b\n👍");
    await app.actions.openPaths(["C:\\data\\small.txt"]);
    expect(app.engine.charCount(app.tab().id)).toBe(5);
    expect(app.engine.length(app.tab().id)).toBe(7);
  });
});
