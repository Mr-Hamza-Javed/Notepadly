/**
 * A light open animation, like a Windows 11 app window appearing: the content
 * fades in while settling from 98.5% to full size (see `.app.entering` in app.css).
 *
 * While the window is hidden (first start, or waiting in the background) the
 * content is kept invisible, so the animation starts from nothing the moment the
 * window shows. Restoring a minimized window does not mark it asleep, so Windows'
 * own restore animation is not doubled.
 */
const html = document.documentElement;

/** Keeps the content invisible until `playEnterAnimation` runs. */
export function markAsleep(): void {
  html.dataset.asleep = "true";
}

export function playEnterAnimation(): void {
  const app = document.querySelector<HTMLElement>(".app");
  delete html.dataset.asleep;
  if (!app) return;
  app.classList.remove("entering");
  // Restart the animation even if it is still running.
  void app.offsetWidth;
  app.classList.add("entering");
  app.addEventListener("animationend", () => app.classList.remove("entering"), { once: true });
}

/** A window woken from the background becomes visible again: play the animation then. */
export function installEnterAnimation(): void {
  const wake = () => {
    if (html.dataset.asleep && document.visibilityState === "visible") playEnterAnimation();
  };
  document.addEventListener("visibilitychange", wake);
  // Safety net: the content must never stay invisible on a window that has focus.
  window.addEventListener("focus", wake);
}
