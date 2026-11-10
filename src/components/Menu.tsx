import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { G, Glyph } from "./icons";
import { focusEditorSoon } from "./focus";

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type Placement = "below-start" | "below-center" | "above-end" | "right-start" | "point";

export function rectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

interface PopupProps extends HTMLAttributes<HTMLDivElement> {
  anchor: AnchorRect;
  placement?: Placement;
  offset?: number;
  popupRef?: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
  children: ReactNode;
}

const EDGE = 4;

/**
 * Fixed-position surface placed against an anchor rect and kept on screen.
 * No portal: `position: fixed` already escapes every overflow ancestor here.
 */
export function Popup({ anchor, placement = "below-start", offset = 0, popupRef, className, children, ...rest }: PopupProps) {
  const local = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = local.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.style.maxHeight = `${vh - EDGE * 2}px`;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = anchor.left;
    let y = anchor.bottom + offset;
    let up = false;
    if (placement === "below-center") x = (anchor.left + anchor.right - w) / 2;
    if (placement === "point") y = anchor.top;
    if (placement === "above-end") {
      x = anchor.right - w;
      y = anchor.top - offset - h;
      up = true;
    }
    if (placement === "right-start") {
      x = anchor.right + offset;
      if (x + w > vw - EDGE) x = anchor.left - offset - w;
      y = anchor.top;
    } else if (!up && y + h > vh - EDGE && anchor.top - offset - h >= EDGE) {
      y = anchor.top - offset - h;
      up = true;
    }
    x = Math.max(EDGE, Math.min(x, vw - w - EDGE));
    y = Math.max(EDGE, Math.min(y, vh - h - EDGE));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    if (up) el.dataset.up = "true";
    // Placement is decided once; an open popup closes on resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      {...rest}
      data-popup=""
      className={className ? `popup ${className}` : "popup"}
      ref={(el) => {
        local.current = el;
        if (popupRef) popupRef.current = el;
      }}
    >
      {children}
    </div>
  );
}

/** Calls `onDismiss` for a press outside every popup, window blur or resize. */
export function useDismiss(onDismiss: (() => void) | null, ignore?: RefObject<HTMLElement | null>): void {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  const enabled = onDismiss !== null;

  useEffect(() => {
    if (!enabled) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.("[data-popup]")) return;
      if (t && ignore?.current?.contains(t)) return;
      cb.current?.();
    };
    const gone = () => cb.current?.();
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", gone);
    window.addEventListener("resize", gone);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("blur", gone);
      window.removeEventListener("resize", gone);
    };
  }, [enabled, ignore]);
}

export interface MenuItem {
  kind?: "item";
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** `undefined` means not checkable; a boolean reserves the check column. */
  checked?: boolean;
  submenu?: MenuEntry[];
  onSelect?: () => void;
  /** Tooltip, e.g. a recent file's full path. */
  tip?: string;
}
export interface MenuSep {
  kind: "sep";
}
export type MenuEntry = MenuItem | MenuSep;

export type CloseReason = "select" | "dismiss" | "left";

export interface MenuProps {
  entries: MenuEntry[];
  anchor: AnchorRect;
  placement?: Placement;
  offset?: number;
  onClose: (reason: CloseReason) => void;
  level?: number;
  autoFocus?: boolean;
  initialActive?: number;
  /** Left/Right past the edge of a top-level menu (menu bar switching). */
  onNav?: (dir: 1 | -1) => void;
  className?: string;
  width?: number;
  compact?: boolean;
  selectedId?: string;
  ignore?: RefObject<HTMLElement | null>;
  onPointerEnter?: () => void;
}

const isItem = (e: MenuEntry | undefined): e is MenuItem => !!e && e.kind !== "sep";
const enabled = (e: MenuEntry | undefined) => isItem(e) && !e.disabled;

/** First enabled index, for opening a menu from the keyboard. */
export function firstEnabled(entries: MenuEntry[]): number {
  return entries.findIndex(enabled);
}

export function Menu({
  entries,
  anchor,
  placement,
  offset,
  onClose,
  level = 0,
  autoFocus = true,
  initialActive = -1,
  onNav,
  className,
  width,
  compact,
  selectedId,
  ignore,
  onPointerEnter,
}: MenuProps) {
  const [active, setActive] = useState(initialActive);
  const [kbd, setKbd] = useState(initialActive >= 0 && !selectedId);
  const [sub, setSub] = useState<{ index: number; anchor: AnchorRect; focus: boolean } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    if (autoFocus) root.current?.focus({ preventScroll: true });
    if (initialActive >= 0) root.current?.querySelector(`[data-i="${initialActive}"]`)?.scrollIntoView({ block: "center" });
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useDismiss(level === 0 ? () => onClose("dismiss") : null, ignore);

  const openSub = (i: number, focus: boolean) => {
    window.clearTimeout(timer.current);
    const el = root.current?.querySelector(`[data-i="${i}"]`);
    const box = root.current;
    if (!el || !box) return;
    const item = el.getBoundingClientRect();
    const outer = box.getBoundingClientRect();
    setSub({ index: i, focus, anchor: { left: outer.left, right: outer.right, top: item.top + 1, bottom: item.bottom } });
  };

  const hover = (i: number) => {
    const e = entries[i];
    setKbd(false);
    if (!isItem(e) || e.disabled) {
      setActive(sub ? sub.index : -1);
      return;
    }
    setActive(i);
    window.clearTimeout(timer.current);
    if (e.submenu) {
      if (sub?.index !== i) timer.current = window.setTimeout(() => openSub(i, false), 200);
    } else if (sub) {
      timer.current = window.setTimeout(() => setSub(null), 180);
    }
  };

  const pick = (i: number) => {
    const e = entries[i];
    if (!isItem(e) || e.disabled) return;
    if (e.submenu) {
      openSub(i, true);
      return;
    }
    onClose("select");
    e.onSelect?.();
    focusEditorSoon();
  };

  const move = (dir: 1 | -1, from = active) => {
    const n = entries.length;
    for (let step = 1, i = from; step <= n; step++) {
      i = (i + dir + n) % n;
      if (enabled(entries[i])) {
        setActive(i);
        setKbd(true);
        root.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1, active < 0 ? 0 : active);
        break;
      case "Home":
        move(1, -1);
        break;
      case "End":
        move(-1, 0);
        break;
      case "Enter":
      case " ":
        if (active >= 0) pick(active);
        break;
      case "ArrowRight": {
        const cur = entries[active];
        if (isItem(cur) && cur.submenu && !cur.disabled) openSub(active, true);
        else onNav?.(1);
        break;
      }
      case "ArrowLeft":
        if (level > 0) onClose("left");
        else onNav?.(-1);
        break;
      case "Escape":
        onClose("dismiss");
        break;
      case "Tab":
        onClose("dismiss");
        break;
      default:
        handled = false;
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const k = e.key.toLowerCase();
          const n = entries.length;
          for (let step = 1; step <= n; step++) {
            const i = (Math.max(active, -1) + step + n) % n;
            const it = entries[i];
            if (enabled(it) && (it as MenuItem).label.toLowerCase().startsWith(k)) {
              setActive(i);
              setKbd(true);
              root.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
              handled = true;
              break;
            }
          }
        }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const hasChecks = entries.some((e) => isItem(e) && e.checked !== undefined);
  const subEntries = sub ? (entries[sub.index] as MenuItem).submenu : undefined;

  return (
    <>
      <Popup
        anchor={anchor}
        placement={placement}
        offset={offset}
        popupRef={root}
        role="menu"
        tabIndex={-1}
        data-kbd={kbd}
        className={`menu${compact ? " compact" : ""}${className ? ` ${className}` : ""}`}
        style={width ? { width } : undefined}
        onKeyDown={onKeyDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={() => {
          if (!sub) setActive(-1);
        }}
      >
        {entries.map((e, i) => {
          if (!isItem(e)) return <div key={i} className="menu-sep" role="separator" />;
          const hot = active === i || sub?.index === i;
          const cls = `menu-item${hot ? " hot" : ""}${e.disabled ? " disabled" : ""}${selectedId === e.id ? " sel" : ""}`;
          return (
            <div
              key={e.id}
              data-i={i}
              data-tip={e.tip}
              role={e.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={e.checked}
              aria-disabled={e.disabled || undefined}
              aria-haspopup={e.submenu ? "menu" : undefined}
              className={cls}
              onPointerMove={() => {
                if (active !== i || kbd) hover(i);
              }}
              onClick={() => pick(i)}
            >
              {hasChecks && <span className="mi-check">{e.checked && <Glyph cp={G.check} size={12} />}</span>}
              <span className="mi-label">{e.label}</span>
              {e.submenu ? (
                <Glyph cp={G.right} size={12} className="mi-chevron" />
              ) : (
                e.shortcut && <span className="mi-shortcut">{e.shortcut}</span>
              )}
            </div>
          );
        })}
      </Popup>
      {sub && subEntries && (
        <Menu
          key={`${sub.index}-${sub.focus}`}
          entries={subEntries}
          anchor={sub.anchor}
          placement="right-start"
          offset={-2}
          level={level + 1}
          autoFocus={sub.focus}
          initialActive={sub.focus ? firstEnabled(subEntries) : -1}
          compact={!subEntries.some((x) => isItem(x) && x.shortcut)}
          onPointerEnter={() => window.clearTimeout(timer.current)}
          onClose={(reason) => {
            if (reason === "select") {
              onClose("select");
              return;
            }
            setSub(null);
            root.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
