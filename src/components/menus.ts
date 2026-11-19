import { engine } from "../editor";
import { findStep } from "../lib/findBar";
import { selectAllLoaded } from "../lib/shortcuts";
import { actions } from "../state/actions";
import { useApp } from "../state/store";
import type { MenuEntry } from "./Menu";

export type MenuId = "file" | "edit" | "view";

const SEP: MenuEntry = { kind: "sep" };
const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);

function recentEntries(): MenuEntry[] {
  const { recent } = useApp.getState();
  if (recent.length === 0) return [{ id: "none", label: "No recent files", disabled: true }];
  const items: MenuEntry[] = recent.slice(0, 10).map((path) => ({
    id: path,
    label: baseName(path),
    tip: path,
    onSelect: () => void actions.openRecent(path),
  }));
  return [...items, SEP, { id: "clear", label: "Clear list", accessKey: "c", onSelect: () => actions.clearRecent() }];
}

function fileMenu(): MenuEntry[] {
  const { activeId } = useApp.getState();
  return [
    { id: "new", label: "New tab", accessKey: "t", shortcut: "Ctrl+N", onSelect: () => actions.newTab() },
    { id: "win", label: "New window", accessKey: "n", shortcut: "Ctrl+Shift+N", onSelect: () => actions.newWindow() },
    { id: "open", label: "Open", accessKey: "o", shortcut: "Ctrl+O", onSelect: () => actions.openDialog() },
    { id: "recent", label: "Recent", accessKey: "r", submenu: recentEntries() },
    { id: "save", label: "Save", accessKey: "s", shortcut: "Ctrl+S", onSelect: () => void actions.save(activeId) },
    { id: "saveas", label: "Save as", accessKey: "a", shortcut: "Ctrl+Shift+S", onSelect: () => void actions.saveAs(activeId) },
    { id: "saveall", label: "Save all", accessKey: "l", shortcut: "Ctrl+Alt+S", onSelect: () => void actions.saveAll() },
    SEP,
    { id: "page", label: "Page setup", accessKey: "u", onSelect: () => actions.showDialog({ kind: "page-setup" }) },
    { id: "print", label: "Print", accessKey: "p", shortcut: "Ctrl+P", onSelect: () => actions.print() },
    SEP,
    { id: "closetab", label: "Close tab", accessKey: "c", shortcut: "Ctrl+W", onSelect: () => void actions.closeTab(activeId) },
    { id: "closewin", label: "Close window", accessKey: "w", shortcut: "Ctrl+Shift+W", onSelect: () => void actions.closeWindow() },
    { id: "exit", label: "Exit", accessKey: "x", onSelect: () => void actions.exit() },
  ];
}

function editMenu(): MenuEntry[] {
  const { cursor, find } = useApp.getState();
  const noSel = cursor.selected === 0;
  const empty = cursor.chars === 0;
  const findAgain = (run: () => void) => () => {
    if (find.open) run();
    else actions.openFind(false);
  };
  return [
    { id: "undo", label: "Undo", accessKey: "u", shortcut: "Ctrl+Z", disabled: !cursor.canUndo, onSelect: () => engine.undo() },
    SEP,
    { id: "cut", label: "Cut", accessKey: "t", shortcut: "Ctrl+X", disabled: noSel, onSelect: () => void actions.clipboard("cut") },
    { id: "copy", label: "Copy", accessKey: "c", shortcut: "Ctrl+C", disabled: noSel, onSelect: () => void actions.clipboard("copy") },
    { id: "paste", label: "Paste", accessKey: "p", shortcut: "Ctrl+V", onSelect: () => void actions.clipboard("paste") },
    { id: "del", label: "Delete", accessKey: "l", shortcut: "Del", disabled: noSel, onSelect: () => engine.deleteSelection() },
    SEP,
    { id: "bing", label: "Search with Bing", accessKey: "s", shortcut: "Ctrl+E", disabled: noSel, onSelect: () => actions.searchWeb() },
    SEP,
    { id: "find", label: "Find", accessKey: "f", shortcut: "Ctrl+F", disabled: empty, onSelect: () => actions.openFind(false) },
    { id: "next", label: "Find next", accessKey: "n", shortcut: "F3", disabled: empty, onSelect: findAgain(() => findStep(1) || engine.findNext()) },
    { id: "prev", label: "Find previous", accessKey: "v", shortcut: "Shift+F3", disabled: empty, onSelect: findAgain(() => findStep(-1) || engine.findPrev()) },
    { id: "replace", label: "Replace", accessKey: "r", shortcut: "Ctrl+H", disabled: empty, onSelect: () => actions.openFind(true) },
    { id: "goto", label: "Go to", accessKey: "g", shortcut: "Ctrl+G", onSelect: () => actions.showDialog({ kind: "goto" }) },
    SEP,
    {
      id: "all",
      label: "Select all",
      accessKey: "a",
      shortcut: "Ctrl+A",
      onSelect: selectAllLoaded,
    },
    { id: "date", label: "Time/Date", accessKey: "d", shortcut: "F5", onSelect: () => actions.insertDateTime() },
    SEP,
    { id: "font", label: "Font", accessKey: "o", onSelect: () => actions.openSettings() },
  ];
}

function viewMenu(): MenuEntry[] {
  const { settings } = useApp.getState();
  return [
    {
      id: "zoom",
      label: "Zoom",
      accessKey: "z",
      submenu: [
        { id: "in", label: "Zoom in", accessKey: "i", shortcut: "Ctrl+Plus", onSelect: () => actions.zoomBy(10) },
        { id: "out", label: "Zoom out", accessKey: "o", shortcut: "Ctrl+Minus", onSelect: () => actions.zoomBy(-10) },
        { id: "reset", label: "Restore default zoom", accessKey: "r", shortcut: "Ctrl+0", onSelect: () => actions.zoomReset() },
      ],
    },
    { id: "status", label: "Status bar", accessKey: "s", checked: settings.statusBar, onSelect: () => actions.setSetting("statusBar", !settings.statusBar) },
    { id: "wrap", label: "Word wrap", accessKey: "w", checked: settings.wordWrap, onSelect: () => actions.setSetting("wordWrap", !settings.wordWrap) },
    { id: "fmt", label: "Formatting", accessKey: "f", checked: settings.formatting, onSelect: () => actions.setSetting("formatting", !settings.formatting) },
  ];
}

/** Read from the store at open time: the menu bar never subscribes to the cursor. */
export function buildMenu(id: MenuId): MenuEntry[] {
  if (id === "file") return fileMenu();
  if (id === "edit") return editMenu();
  return viewMenu();
}
