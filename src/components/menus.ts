import { engine } from "../editor";
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
  return [...items, SEP, { id: "clear", label: "Clear list", onSelect: () => actions.clearRecent() }];
}

function fileMenu(): MenuEntry[] {
  const { activeId } = useApp.getState();
  return [
    { id: "new", label: "New tab", shortcut: "Ctrl+N", onSelect: () => actions.newTab() },
    { id: "win", label: "New window", shortcut: "Ctrl+Shift+N", onSelect: () => actions.newWindow() },
    { id: "open", label: "Open", shortcut: "Ctrl+O", onSelect: () => actions.openDialog() },
    { id: "recent", label: "Recent", submenu: recentEntries() },
    { id: "save", label: "Save", shortcut: "Ctrl+S", onSelect: () => void actions.save(activeId) },
    { id: "saveas", label: "Save as", shortcut: "Ctrl+Shift+S", onSelect: () => void actions.saveAs(activeId) },
    { id: "saveall", label: "Save all", shortcut: "Ctrl+Alt+S", onSelect: () => void actions.saveAll() },
    SEP,
    { id: "page", label: "Page setup", onSelect: () => actions.showDialog({ kind: "page-setup" }) },
    { id: "print", label: "Print", shortcut: "Ctrl+P", onSelect: () => actions.print() },
    SEP,
    { id: "closetab", label: "Close tab", shortcut: "Ctrl+W", onSelect: () => void actions.closeTab(activeId) },
    { id: "closewin", label: "Close window", shortcut: "Ctrl+Shift+W", onSelect: () => void actions.closeWindow() },
    { id: "exit", label: "Exit", onSelect: () => void actions.exit() },
  ];
}

function editMenu(): MenuEntry[] {
  const { cursor, find, activeId } = useApp.getState();
  const noSel = cursor.selected === 0;
  const empty = cursor.chars === 0;
  const findAgain = (run: () => void) => () => {
    if (find.open) run();
    else actions.openFind(false);
  };
  return [
    { id: "undo", label: "Undo", shortcut: "Ctrl+Z", disabled: !cursor.canUndo, onSelect: () => engine.undo() },
    SEP,
    { id: "cut", label: "Cut", shortcut: "Ctrl+X", disabled: noSel, onSelect: () => engine.cut() },
    { id: "copy", label: "Copy", shortcut: "Ctrl+C", disabled: noSel, onSelect: () => engine.copy() },
    { id: "paste", label: "Paste", shortcut: "Ctrl+V", onSelect: () => engine.paste() },
    { id: "del", label: "Delete", shortcut: "Del", disabled: noSel, onSelect: () => engine.deleteSelection() },
    SEP,
    { id: "bing", label: "Search with Bing", shortcut: "Ctrl+E", disabled: noSel, onSelect: () => actions.searchWeb() },
    SEP,
    { id: "find", label: "Find", shortcut: "Ctrl+F", disabled: empty, onSelect: () => actions.openFind(false) },
    { id: "next", label: "Find next", shortcut: "F3", disabled: empty, onSelect: findAgain(() => engine.findNext()) },
    { id: "prev", label: "Find previous", shortcut: "Shift+F3", disabled: empty, onSelect: findAgain(() => engine.findPrev()) },
    { id: "replace", label: "Replace", shortcut: "Ctrl+H", disabled: empty, onSelect: () => actions.openFind(true) },
    { id: "goto", label: "Go to", shortcut: "Ctrl+G", onSelect: () => actions.showDialog({ kind: "goto" }) },
    SEP,
    {
      id: "all",
      label: "Select all",
      shortcut: "Ctrl+A",
      onSelect: () => void actions.ensureFullyLoaded(activeId).then(() => engine.selectAll()),
    },
    { id: "date", label: "Time/Date", shortcut: "F5", onSelect: () => actions.insertDateTime() },
    SEP,
    { id: "font", label: "Font", onSelect: () => actions.openSettings() },
  ];
}

function viewMenu(): MenuEntry[] {
  const { settings } = useApp.getState();
  return [
    {
      id: "zoom",
      label: "Zoom",
      submenu: [
        { id: "in", label: "Zoom in", shortcut: "Ctrl+Plus", onSelect: () => actions.zoomBy(10) },
        { id: "out", label: "Zoom out", shortcut: "Ctrl+Minus", onSelect: () => actions.zoomBy(-10) },
        { id: "reset", label: "Restore default zoom", shortcut: "Ctrl+0", onSelect: () => actions.zoomReset() },
      ],
    },
    { id: "status", label: "Status bar", checked: settings.statusBar, onSelect: () => actions.setSetting("statusBar", !settings.statusBar) },
    { id: "wrap", label: "Word wrap", checked: settings.wordWrap, onSelect: () => actions.setSetting("wordWrap", !settings.wordWrap) },
    { id: "fmt", label: "Formatting", checked: settings.formatting, onSelect: () => actions.setSetting("formatting", !settings.formatting) },
  ];
}

/** Read from the store at open time: the menu bar never subscribes to the cursor. */
export function buildMenu(id: MenuId): MenuEntry[] {
  if (id === "file") return fileMenu();
  if (id === "edit") return editMenu();
  return viewMenu();
}
