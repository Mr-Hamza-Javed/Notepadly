import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { engine } from "../editor";
import type { FormatCommand } from "../editor/api";
import { G, Glyph } from "./icons";
import { Menu, Popup, rectOf, useDismiss, type AnchorRect, type CloseReason, type MenuEntry } from "./Menu";
import { focusEditorSoon } from "./focus";

const SIZE = 5;

type Cursor = { r: number; c: number } | "insert" | "edit";

const EDIT_OPS: { id: string; label: string; op: Extract<FormatCommand, { type: "table-edit" }>["op"] }[] = [
  { id: "ra", label: "Insert row above", op: "row-above" },
  { id: "rb", label: "Insert row below", op: "row-below" },
  { id: "cl", label: "Insert column left", op: "col-left" },
  { id: "cr", label: "Insert column right", op: "col-right" },
  { id: "dr", label: "Delete row", op: "del-row" },
  { id: "dc", label: "Delete column", op: "del-col" },
  { id: "dt", label: "Delete table", op: "del-table" },
];

export function TablePicker({
  anchor,
  inTable,
  ignore,
  onClose,
}: {
  anchor: AnchorRect;
  inTable: boolean;
  ignore: RefObject<HTMLElement | null>;
  onClose: (reason: CloseReason) => void;
}) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [kbd, setKbd] = useState(false);
  const [editAnchor, setEditAnchor] = useState<{ rect: AnchorRect; focus: boolean } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const editRow = useRef<HTMLDivElement | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
    return () => window.clearTimeout(timer.current);
  }, []);

  useDismiss(() => onClose("dismiss"), ignore);

  const insert = (rows: number, cols: number) => {
    onClose("select");
    engine.format({ type: "table-insert", rows, cols });
    focusEditorSoon();
  };

  const openEdit = (focus: boolean) => {
    window.clearTimeout(timer.current);
    if (!inTable || !editRow.current || !root.current) return;
    const row = rectOf(editRow.current);
    const box = rectOf(root.current);
    setEditAnchor({ rect: { ...row, left: box.left, right: box.right }, focus });
  };

  const grid = cursor && typeof cursor === "object" ? cursor : null;
  const editHot = cursor === "edit" || !!editAnchor;

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key;
    let handled = true;
    setKbd(true);
    if (k === "Escape" || k === "Tab") {
      onClose("dismiss");
    } else if (cursor === null) {
      if (k.startsWith("Arrow")) setCursor({ r: 0, c: 0 });
      else handled = false;
    } else if (typeof cursor === "object") {
      if (k === "ArrowRight") setCursor({ ...cursor, c: Math.min(SIZE - 1, cursor.c + 1) });
      else if (k === "ArrowLeft") setCursor({ ...cursor, c: Math.max(0, cursor.c - 1) });
      else if (k === "ArrowUp") setCursor({ ...cursor, r: Math.max(0, cursor.r - 1) });
      else if (k === "ArrowDown") setCursor(cursor.r === SIZE - 1 ? "insert" : { ...cursor, r: cursor.r + 1 });
      else if (k === "Enter" || k === " ") insert(cursor.r + 1, cursor.c + 1);
      else handled = false;
    } else if (cursor === "insert") {
      if (k === "ArrowUp") setCursor({ r: SIZE - 1, c: 0 });
      else if (k === "ArrowDown") setCursor(inTable ? "edit" : "insert");
      else if (k === "Enter" || k === " ") insert(3, 3);
      else handled = false;
    } else {
      if (k === "ArrowUp") setCursor("insert");
      else if (k === "ArrowRight" || k === "Enter" || k === " ") openEdit(true);
      else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const editEntries: MenuEntry[] = EDIT_OPS.map((o) => ({
    id: o.id,
    label: o.label,
    disabled: !inTable,
    onSelect: () => engine.format({ type: "table-edit", op: o.op }),
  }));
  const withSeps: MenuEntry[] = [...editEntries.slice(0, 4), { kind: "sep" }, ...editEntries.slice(4)];

  return (
    <>
      <Popup
        anchor={anchor}
        placement="below-center"
        offset={5}
        popupRef={root}
        tabIndex={-1}
        role="menu"
        className="table-pop"
        data-kbd={kbd}
        onKeyDown={onKeyDown}
      >
        <div className="table-title">{grid ? `${grid.r + 1} × ${grid.c + 1} table` : "Insert table"}</div>
        <div className="table-grid" onPointerLeave={() => setCursor(null)}>
          {Array.from({ length: SIZE * SIZE }, (_, i) => {
            const r = Math.floor(i / SIZE);
            const c = i % SIZE;
            const on = !!grid && r <= grid.r && c <= grid.c;
            const hot = !!grid && r === grid.r && c === grid.c;
            return (
              <div
                key={i}
                className={`table-cell${on ? " on" : ""}${hot ? " hot" : ""}`}
                onPointerEnter={() => {
                  setKbd(false);
                  setCursor({ r, c });
                  setEditAnchor(null);
                }}
                onClick={() => insert(r + 1, c + 1)}
              />
            );
          })}
        </div>
        <div className="menu-sep" />
        <div
          className={`menu-item${cursor === "insert" ? " hot" : ""}`}
          role="menuitem"
          onPointerMove={() => {
            setKbd(false);
            setCursor("insert");
            setEditAnchor(null);
          }}
          onClick={() => insert(3, 3)}
        >
          <span className="mi-label">Insert table</span>
        </div>
        <div
          ref={editRow}
          className={`menu-item${editHot && inTable ? " hot" : ""}${inTable ? "" : " disabled"}`}
          role="menuitem"
          aria-disabled={!inTable || undefined}
          aria-haspopup="menu"
          onPointerMove={() => {
            if (!inTable || cursor === "edit") return;
            setKbd(false);
            setCursor("edit");
            timer.current = window.setTimeout(() => openEdit(false), 200);
          }}
          onClick={() => openEdit(true)}
        >
          <span className="mi-label">Edit table</span>
          <Glyph cp={G.right} size={12} className="mi-chevron" />
        </div>
      </Popup>
      {editAnchor && (
        <Menu
          key={String(editAnchor.focus)}
          entries={withSeps}
          anchor={editAnchor.rect}
          placement="right-start"
          offset={-2}
          level={1}
          autoFocus={editAnchor.focus}
          initialActive={editAnchor.focus ? 0 : -1}
          compact
          onClose={(reason) => {
            if (reason === "select") {
              onClose("select");
              return;
            }
            setEditAnchor(null);
            root.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
