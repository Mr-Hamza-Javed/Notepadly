// Browser entry for the end-to-end tests: installs a fake Tauri backend behind the
// real @tauri-apps/api (window.__TAURI_INTERNALS__, through its own mocks module),
// then boots the full app exactly as src/main.tsx does in the WebView.
//
// Commands go to the same in-memory FakeBackend the vitest app tests use
// (src/test/fakeTauri.ts). Plugin commands (window, webview, dialog, opener, app)
// get small stand-ins here. A test seeds files and pending paths before the page
// loads through `window.__E2E_SEED__` (see e2e/fixtures.ts).
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { backend, dialogs } from "../src/test/fakeTauri";
import type { E2eSeed } from "./seed";

declare global {
  interface Window {
    __E2E_SEED__?: E2eSeed;
    e2e: {
      backend: typeof backend;
      dialogs: typeof dialogs;
      /** Every IPC call, plugin commands included, in order. */
      ipc: { cmd: string; args: Record<string, unknown> }[];
      /** The editor's CodeMirror view. */
      view: () => import("@codemirror/view").EditorView | null;
      state: () => import("../src/state/types").AppState;
    };
  }
}

const seed: E2eSeed = window.__E2E_SEED__ ?? {};
const ipcLog: { cmd: string; args: Record<string, unknown> }[] = [];

backend.reset();
backend.runStartedAt = Date.now();
backend.windows.add("main");
for (const [path, text] of Object.entries(seed.files ?? {})) backend.write(path, text);
backend.pendingPaths = [...(seed.open ?? [])];
backend.dropTarget = seed.dropTarget ?? null;
try {
  localStorage.clear();
  if (seed.settings) localStorage.setItem("notepadly.settings.v1", JSON.stringify(seed.settings));
} catch {
  // Storage blocked: the app falls back to its defaults.
}

function plugin(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case "plugin:window|is_focused":
      return true;
    case "plugin:window|scale_factor":
      return 1;
    case "plugin:app|version":
      return "0.1.0";
    case "plugin:dialog|save":
      dialogs.saveRequests.push((args.options ?? {}) as { defaultPath?: string });
      return dialogs.saveAnswers.shift() ?? null;
    case "plugin:dialog|open":
      return dialogs.openAnswers.shift() ?? null;
    case "plugin:dialog|message":
      dialogs.messages.push({ title: args.title as string | undefined, body: String(args.message ?? "") });
      return dialogs.messageAnswers.shift() ?? "Cancel";
    case "plugin:dialog|ask":
    case "plugin:dialog|confirm":
      dialogs.asked.push(String(args.message ?? ""));
      return dialogs.askAnswers.shift() ?? false;
    case "plugin:opener|open_url":
      dialogs.openedUrls.push(String(args.url));
      return null;
    case "plugin:opener|open_path":
      dialogs.openedPaths.push(String(args.path));
      return null;
    default:
      // Window and webview calls (show, set_focus, set_theme, ...) need no answer.
      return null;
  }
}

mockWindows("main");
mockConvertFileSrc("windows");
mockIPC(
  (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    ipcLog.push({ cmd, args });
    if (cmd.startsWith("plugin:")) return plugin(cmd, args);
    return backend.invoke(cmd, args, "main");
  },
  { shouldMockEvents: true },
);

const { EditorView } = await import("@codemirror/view");
const { useApp } = await import("../src/state/store");

window.e2e = {
  backend,
  dialogs,
  ipc: ipcLog,
  view: () => {
    const dom = document.querySelector<HTMLElement>(".cm-editor");
    return dom ? EditorView.findFromDOM(dom) : null;
  },
  state: () => useApp.getState(),
};

await import("../src/main");
