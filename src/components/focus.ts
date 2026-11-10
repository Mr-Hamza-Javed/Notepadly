import { engine } from "../editor";
import { useApp } from "../state/store";

/**
 * Returns focus to the editor after a menu, toolbar or dialog action, unless
 * something the action opened (a dialog, the find bar, settings) took it.
 * Runs on the next frame, so React has already committed whatever opened.
 */
export function focusEditorSoon(): void {
  requestAnimationFrame(() => {
    const s = useApp.getState();
    if (s.dialog || s.view !== "editor") return;
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    engine.focus();
  });
}
