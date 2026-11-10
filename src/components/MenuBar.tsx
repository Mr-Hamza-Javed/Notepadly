import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { engine } from "../editor";
import { useApp } from "../state/store";
import { firstEnabled, Menu, rectOf } from "./Menu";
import { buildMenu, type MenuId } from "./menus";
import { focusEditorSoon } from "./focus";

const HEADS: { id: MenuId; label: string; key: string }[] = [
  { id: "file", label: "File", key: "f" },
  { id: "edit", label: "Edit", key: "e" },
  { id: "view", label: "View", key: "v" },
];

const cycle = (id: MenuId, dir: 1 | -1): MenuId => {
  const i = HEADS.findIndex((h) => h.id === id);
  return HEADS[(i + dir + HEADS.length) % HEADS.length].id;
};

export const MenuBar = memo(function MenuBar() {
  const [open, setOpen] = useState<{ id: MenuId; kbd: boolean } | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const head = (id: MenuId) => bar.current?.querySelector<HTMLButtonElement>(`[data-head="${id}"]`) ?? null;

  const show = useCallback((id: MenuId, kbd: boolean) => setOpen({ id, kbd }), []);

  // Alt alone focuses the bar; Alt+F/E/V opens directly.
  useEffect(() => {
    let altOnly = false;
    const blocked = () => {
      const s = useApp.getState();
      return s.dialog !== null || s.view !== "editor";
    };
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Alt") {
        if (!e.repeat) altOnly = true;
        e.preventDefault();
        return;
      }
      altOnly = false;
      if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || blocked()) return;
      const hit = HEADS.find((h) => h.key === e.key.toLowerCase());
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        show(hit.id, true);
      }
    };
    const up = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Alt" || !altOnly) return;
      altOnly = false;
      e.preventDefault();
      if (blocked()) return;
      if (openRef.current) {
        setOpen(null);
        engine.focus();
      } else if (bar.current?.contains(document.activeElement)) {
        engine.focus();
      } else {
        bar.current?.querySelector<HTMLButtonElement>("[data-head]")?.focus();
      }
    };
    const blur = () => {
      altOnly = false;
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, [show]);

  const onHeadKey = (e: KeyboardEvent, id: MenuId) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowLeft":
        e.preventDefault();
        head(cycle(id, e.key === "ArrowRight" ? 1 : -1))?.focus();
        break;
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        show(id, true);
        break;
      case "Escape":
        e.preventDefault();
        engine.focus();
        break;
      default:
    }
  };

  const el = open ? head(open.id) : null;
  const entries = open ? buildMenu(open.id) : null;

  return (
    <div ref={bar} className="menubar" role="menubar">
      {HEADS.map((h) => (
        <button
          key={h.id}
          type="button"
          role="menuitem"
          className="menu-head"
          data-head={h.id}
          data-open={open?.id === h.id}
          aria-haspopup="menu"
          aria-expanded={open?.id === h.id}
          onClick={() => {
            if (open?.id === h.id) {
              setOpen(null);
              focusEditorSoon();
            } else {
              show(h.id, false);
            }
          }}
          onPointerEnter={() => {
            if (open && open.id !== h.id) show(h.id, false);
          }}
          onKeyDown={(e) => onHeadKey(e, h.id)}
        >
          {h.label}
        </button>
      ))}
      {open && el && entries && (
        <Menu
          key={open.id}
          entries={entries}
          anchor={rectOf(el)}
          offset={4}
          width={224}
          ignore={bar}
          initialActive={open.kbd ? firstEnabled(entries) : -1}
          onNav={(dir) => show(cycle(open.id, dir), true)}
          onClose={(reason) => {
            setOpen(null);
            if (reason !== "select") focusEditorSoon();
          }}
        />
      )}
    </div>
  );
});
