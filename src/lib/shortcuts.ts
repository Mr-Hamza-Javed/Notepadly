// Global keyboard handling, in the capture phase so it runs before the editor.
import { engine } from "../editor";
import { actions } from "../state/actions";
import { getActiveTab, useApp } from "../state/store";

export type Command =
  | "newTab" | "newWindow" | "open" | "save" | "saveAs" | "saveAll" | "print" | "closeTab" | "closeWindow"
  | "undo" | "redo" | "searchWeb" | "find" | "findNext" | "findPrev" | "replace" | "goTo" | "selectAll" | "dateTime"
  | "zoomIn" | "zoomOut" | "zoomReset" | "nextTab" | "prevTab" | "tab1" | "tab2" | "tab3" | "tab4" | "tab5"
  | "tab6" | "tab7" | "tab8" | "tabLast" | "bold" | "italic" | "link" | "docEnd" | "docEndSelect";

export interface Chord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

const CTRL_KEYS: Record<string, Command> = {
  n: "newTab", o: "open", s: "save", p: "print", w: "closeTab", z: "undo", y: "redo", e: "searchWeb", f: "find",
  h: "replace", g: "goTo", a: "selectAll", b: "bold", i: "italic", k: "link", tab: "nextTab", end: "docEnd",
  "+": "zoomIn", "=": "zoomIn", "-": "zoomOut", _: "zoomOut", "0": "zoomReset",
  "1": "tab1", "2": "tab2", "3": "tab3", "4": "tab4", "5": "tab5", "6": "tab6", "7": "tab7", "8": "tab8", "9": "tabLast",
};

const CTRL_SHIFT_KEYS: Record<string, Command> = {
  n: "newWindow", s: "saveAs", w: "closeWindow", z: "redo", tab: "prevTab", end: "docEndSelect",
  "+": "zoomIn", "=": "zoomIn",
};

export function chordToCommand({ key, ctrl, shift, alt }: Chord): Command | null {
  const k = key.toLowerCase();
  if (ctrl && alt) return !shift && k === "s" ? "saveAll" : null;
  if (alt) return null;
  if (ctrl) return (shift ? CTRL_SHIFT_KEYS[k] : CTRL_KEYS[k]) ?? null;
  if (k === "f3") return shift ? "findPrev" : "findNext";
  if (k === "f5" && !shift) return "dateTime";
  return null;
}

/** WebView behaviour that must never reach a notepad, handled or not. */
export function isSuppressedDefault({ key, ctrl, shift, alt }: Chord, production: boolean): boolean {
  const k = key.toLowerCase();
  if (k === "f5" || k === "f7" || k === "browserback" || k === "browserforward") return true;
  if (k === "f12") return production;
  if (alt && (k === "arrowleft" || k === "arrowright")) return true;
  if (!ctrl) return false;
  if ("prfgujdl".includes(k) && k.length === 1) return true;
  if (shift && (k === "i" || k === "j" || k === "c")) return production;
  return k === "+" || k === "=" || k === "-" || k === "_" || k === "0";
}

/** Commands an input or textarea must keep for itself. */
const NATIVE_IN_INPUT = new Set<Command>(["undo", "redo", "selectAll", "docEnd", "docEndSelect"]);
const REPEATABLE = new Set<Command>(["undo", "redo", "findNext", "findPrev", "zoomIn", "zoomOut", "nextTab", "prevTab"]);

function isNativeInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest("input, textarea, select");
}

function isTextSurface(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest("input, textarea, select, [contenteditable='true'], .cm-content");
}

function selectAllLoaded(): void {
  const id = useApp.getState().activeId;
  actions
    .ensureFullyLoaded(id)
    .then(() => {
      if (useApp.getState().activeId === id) engine.selectAll();
    })
    .catch(() => {});
}

/** Handled only for partial files: otherwise the editor's own key binding is right. */
function goToDocEnd(extend: boolean): boolean {
  const tab = getActiveTab();
  if (!tab || tab.fullyLoaded) return false;
  const id = tab.id;
  actions
    .ensureFullyLoaded(id)
    .then(() => {
      if (useApp.getState().activeId !== id) return;
      const length = engine.length(id);
      const anchor = extend ? engine.snapshot(id)?.anchor ?? length : length;
      engine.restore(id, { anchor, head: length, scrollTop: 1e9 });
    })
    .catch(() => {});
  return true;
}

function openLinkDialog(): void {
  useApp.setState({ dialog: { kind: "link", initialText: engine.selectionText(), initialUrl: "" } });
}

function activateIndex(index: number): void {
  const { tabs } = useApp.getState();
  const tab = index < 0 ? tabs[tabs.length - 1] : tabs[index];
  if (tab) void actions.activate(tab.id);
}

/** Returns false when the key should carry on to the editor. */
function run(command: Command): boolean {
  const mode = getActiveTab()?.mode;
  const find = useApp.getState().find;
  switch (command) {
    case "newTab": void actions.newTab(); return true;
    case "newWindow": void actions.newWindow(); return true;
    case "open": void actions.openDialog(); return true;
    case "save": void actions.save(); return true;
    case "saveAs": void actions.saveAs(); return true;
    case "saveAll": void actions.saveAll(); return true;
    case "print": void actions.print(); return true;
    case "closeTab": void actions.closeTab(useApp.getState().activeId); return true;
    case "closeWindow": void actions.closeWindow(); return true;
    case "undo": engine.undo(); return true;
    case "redo": engine.redo(); return true;
    case "searchWeb": actions.searchWeb(); return true;
    case "find": actions.openFind(false); return true;
    case "replace": actions.openFind(true); return true;
    case "findNext":
      if (find.open) engine.findNext();
      else actions.openFind(false);
      return true;
    case "findPrev":
      if (find.open) engine.findPrev();
      else actions.openFind(false);
      return true;
    case "goTo": actions.showDialog({ kind: "goto" }); return true;
    case "selectAll": selectAllLoaded(); return true;
    case "dateTime": actions.insertDateTime(); return true;
    case "zoomIn": actions.zoomBy(10); return true;
    case "zoomOut": actions.zoomBy(-10); return true;
    case "zoomReset": actions.zoomReset(); return true;
    case "nextTab": void actions.nextTab(1); return true;
    case "prevTab": void actions.nextTab(-1); return true;
    case "tabLast": activateIndex(-1); return true;
    case "tab1": case "tab2": case "tab3": case "tab4":
    case "tab5": case "tab6": case "tab7": case "tab8":
      activateIndex(Number(command.slice(3)) - 1);
      return true;
    case "bold":
    case "italic":
      if (mode !== "plain") engine.format({ type: command });
      return true;
    case "link":
      if (mode !== "plain") openLinkDialog();
      return true;
    case "docEnd": return goToDocEnd(false);
    case "docEndSelect": return goToDocEnd(true);
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.isComposing || event.getModifierState("AltGraph")) return;
  const chord: Chord = { key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey };
  const production = !!import.meta.env?.PROD;
  const { dialog, view, find } = useApp.getState();
  const stop = () => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (event.key === "Escape") {
    if (dialog) {
      // Focus inside the dialog: its own handler answers and restores focus.
      if (event.target instanceof HTMLElement && event.target.closest(".smoke")) return;
      stop();
      actions.closeDialog();
    } else if (!document.querySelector("[role='menu']")) {
      if (view === "settings") {
        stop();
        actions.closeSettings();
      } else if (find.open) {
        stop();
        actions.closeFind();
      }
    }
    return;
  }

  if (!dialog && view === "editor") {
    const command = chordToCommand(chord);
    if (command && !(isNativeInput(event.target) && NATIVE_IN_INPUT.has(command))) {
      if (event.repeat && !REPEATABLE.has(command)) {
        stop();
        return;
      }
      if (run(command)) {
        stop();
        return;
      }
    }
  }
  if (isSuppressedDefault(chord, production)) event.preventDefault();
}

function onContextMenu(event: MouseEvent): void {
  if (!isTextSurface(event.target)) event.preventDefault();
}

/** Ctrl+wheel inside the editor is the engine's; elsewhere it must not zoom the WebView. */
function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (event.target instanceof HTMLElement && event.target.closest(".cm-editor")) return;
  actions.zoomBy(event.deltaY < 0 ? 10 : -10);
}

let installed = false;

export function installShortcuts(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("contextmenu", onContextMenu, { capture: true });
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
}
