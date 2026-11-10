import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { actions } from "./state/actions";
import { useApp } from "./state/store";
import "./styles/app.css";

/** How long a slow session restore may hold back the first show. */
const INIT_SHOW_BUDGET_MS = 220;

const html = document.documentElement;

// Critical paint: the bundled stylesheet may not have applied yet.
html.style.background = useApp.getState().dark ? "#212121" : "#d2dbea";

interface UaDataLike {
  getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }>;
}

/** Mica needs Windows 11, which reports platform version 13 or later. */
async function detectMica(): Promise<boolean> {
  try {
    const ua = (navigator as Navigator & { userAgentData?: UaDataLike }).userAgentData;
    const info = await ua?.getHighEntropyValues?.(["platformVersion"]);
    return Number.parseInt(info?.platformVersion ?? "0", 10) >= 13;
  } catch {
    return false;
  }
}

const nextPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function boot(): Promise<void> {
  const root = createRoot(document.getElementById("root") as HTMLElement);
  flushSync(() => root.render(<App />));

  const init = actions.init().catch((error: unknown) => console.error("Notepadly: init failed", error));
  const [mica] = await Promise.all([detectMica(), Promise.race([init, delay(INIT_SHOW_BUDGET_MS)])]);

  if (mica) html.dataset.mica = "on";
  html.style.removeProperty("background");

  await nextPaint();
  try {
    await getCurrentWindow().show();
  } catch {
    // Plain browser preview: there is no native window to show.
  }
}

void boot();
