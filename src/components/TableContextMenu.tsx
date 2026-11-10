import { memo, useEffect, useState } from "react";
import { engine } from "../editor";
import { Menu, type AnchorRect, type MenuEntry } from "./Menu";
import { EDIT_OPS } from "./TablePicker";
import { focusEditorSoon } from "./focus";

const CELL = ".cm-md-table th, .cm-md-table td";

function entries(): MenuEntry[] {
  const items: MenuEntry[] = EDIT_OPS.map((o) => ({
    id: o.id,
    label: o.label,
    onSelect: () => engine.format({ type: "table-edit", op: o.op }),
  }));
  return [...items.slice(0, 4), { kind: "sep" }, ...items.slice(4)];
}

/**
 * Right-clicking a rendered table cell shows the table's edit commands (insert or delete
 * rows and columns, delete the table) instead of the browser's menu.
 */
export const TableContextMenu = memo(function TableContextMenu() {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const cell = event.target instanceof Element ? event.target.closest<HTMLElement>(CELL) : null;
      if (!cell) return;
      event.preventDefault();
      // Focusing the cell parks the editor selection in it, so the commands apply to this cell.
      if (!cell.contains(document.activeElement)) cell.focus({ preventScroll: true });
      let x = event.clientX;
      let y = event.clientY;
      if (x === 0 && y === 0) {
        // Opened from the keyboard (Menu key or Shift+F10).
        const r = cell.getBoundingClientRect();
        x = r.left + 8;
        y = r.bottom;
      }
      setAnchor({ left: x, right: x, top: y, bottom: y });
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  if (!anchor) return null;
  return (
    <Menu
      entries={entries()}
      anchor={anchor}
      placement="point"
      width={224}
      onClose={(reason) => {
        setAnchor(null);
        if (reason !== "select") focusEditorSoon();
      }}
    />
  );
});
