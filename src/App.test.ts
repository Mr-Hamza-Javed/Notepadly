// @vitest-environment jsdom
// The whole window: what the keyboard can reach on the Settings and Help pages.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootApp, type App } from "./test/appHarness";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("./test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("./test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("./test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("./test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("./test/fakeTauri")).tauriMocks.opener());

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

let app: App;
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  const r = root;
  if (r) await act(async () => r.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("pages over the editor", () => {
  // BUGS.md UI-6: Tab on the Settings page went on to the hidden tabs, menu bar and status bar.
  it("the editor chrome under Settings and Help cannot be reached", async () => {
    app = await bootApp();
    const { default: AppView } = await import("./App");
    const el = document.body.appendChild(document.createElement("div"));
    host = el;
    const r = createRoot(el);
    root = r;
    await act(async () => r.render(createElement(AppView)));
    const chrome = () => ["[role='tablist']", ".menubar", ".statusbar"].map((s) => el.querySelector(s)!);
    for (const node of chrome()) expect(node.closest("[inert]")).toBeNull();
    await act(async () => app.actions.openSettings());
    for (const node of chrome()) expect(node.closest("[inert]"), node.className).not.toBeNull();
    await act(async () => app.actions.closeSettings());
    for (const node of chrome()) expect(node.closest("[inert]")).toBeNull();
    await act(async () => app.actions.openHelp());
    for (const node of chrome()) expect(node.closest("[inert]")).not.toBeNull();
  });
});
