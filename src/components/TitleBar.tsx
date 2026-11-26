import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { actions } from "../state/actions";
import { ipc } from "../lib/ipc";
import { useApp } from "../state/store";
import type { TabMeta } from "../state/types";
import { AppIcon, G, Glyph } from "./icons";
import { Menu, type AnchorRect, type MenuEntry } from "./Menu";
import { CaptionButtons } from "./CaptionButtons";
import { focusEditorSoon } from "./focus";
import {
  hoverGapIndex,
  insertionIndex,
  isPulledOut,
  onTabStripNews,
  reorderTarget,
  setHoverGapIndex,
  setTabDragging,
} from "../lib/tabDrag";

interface TabProps {
  tab: TabMeta;
  active: boolean;
  index: number;
  onPressTab: (e: PointerEvent<HTMLDivElement>, index: number, id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
}

const Tab = memo(function Tab({ tab, active, index, onPressTab, onMenu }: TabProps) {
  const { id } = tab;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const list = e.currentTarget.parentElement;
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        actions.activate(id);
        focusEditorSoon();
        break;
      case "Delete":
        e.preventDefault();
        void actions.closeTab(id);
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : list?.children.length ? list.children.length - 1 : 0;
        const n = list?.children.length ?? 1;
        (list?.children[(index + dir) % n] as HTMLElement | undefined)?.focus();
        break;
      }
      case "Home":
      case "End": {
        e.preventDefault();
        const n = list?.children.length ?? 0;
        (list?.children[e.key === "Home" ? 0 : n - 1] as HTMLElement | undefined)?.focus();
        break;
      }
      case "ContextMenu":
      case "F10":
        if (e.key === "ContextMenu" || e.shiftKey) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(id, r.left + 8, r.bottom);
        }
        break;
      default:
    }
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={tab.dirty ? `${tab.title}, unsaved` : tab.title}
      aria-keyshortcuts="Delete"
      tabIndex={active ? 0 : -1}
      className="tab"
      data-tab-id={id}
      data-active={active}
      data-dirty={tab.dirty}
      data-tip={tab.path ?? tab.title}
      onPointerDown={(e) => onPressTab(e, index, id)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void actions.closeTab(id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(id, e.clientX, e.clientY);
      }}
      onKeyDown={onKeyDown}
    >
      <span className="tab-title">{tab.title}</span>
      <button
        type="button"
        className="tab-close"
        // Not a second control inside role="tab" (nested interactive): the keyboard
        // closes a tab with Delete or its context menu, so this is for the mouse.
        tabIndex={-1}
        aria-hidden="true"
        data-tip="Close tab"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void actions.closeTab(id);
        }}
      >
        <span className="dot" />
        <Glyph cp={G.closeSmall} size={10} className="x" />
      </button>
    </div>
  );
});

function tabMenu(id: string): MenuEntry[] {
  const { tabs } = useApp.getState();
  const index = tabs.findIndex((t) => t.id === id);
  const tab = tabs[index];
  const hasPath = !!tab?.path;
  return [
    { id: "close", label: "Close", accessKey: "c", onSelect: () => void actions.closeTab(id) },
    { id: "others", label: "Close others", accessKey: "o", disabled: tabs.length < 2, onSelect: () => void actions.closeOthers(id) },
    { id: "right", label: "Close to the right", accessKey: "r", disabled: index >= tabs.length - 1, onSelect: () => void actions.closeToRight(id) },
    { kind: "sep" },
    { id: "newwindow", label: "Move to new window", accessKey: "n", disabled: tabs.length < 2, onSelect: () => void actions.moveTabOut(id, true) },
    { kind: "sep" },
    { id: "copy", label: "Copy path", accessKey: "p", disabled: !hasPath, onSelect: () => void actions.copyPath(id) },
    { id: "reveal", label: "Reveal in Explorer", accessKey: "e", disabled: !hasPath, onSelect: () => void actions.revealTab(id) },
  ];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Flex would otherwise size the scroller from tab content, not the 233px basis. */
const TAB_WIDTH = 233;
/** .tab-list side padding, room for the active tab's flare without overflowing. */
const TAB_LIST_PADDING = 8;

/** Where the first tab starts, in viewport px, with the strip scrolled to the start. */
function stripOrigin(sc: HTMLElement, ls: HTMLElement): number {
  return sc.getBoundingClientRect().left + (Number.parseFloat(getComputedStyle(ls).paddingLeft) || 0);
}

/** A tab from another window, snapped into this strip under the mouse (F2). */
interface Phantom {
  left: number;
  top: number;
  width: number;
  title: string;
  dirty: boolean;
}

const TabStrip = memo(function TabStrip() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const scroller = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [menu, setMenu] = useState<{ id: string; anchor: AnchorRect } | null>(null);
  const [phantom, setPhantom] = useState<Phantom | null>(null);

  // Arrows appear only once tabs have shrunk to their minimum and still spill.
  useLayoutEffect(() => {
    const sc = scroller.current;
    const ls = list.current;
    if (!sc || !ls) return;
    const check = () => setOverflow(ls.scrollWidth > sc.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(sc);
    ro.observe(ls);
    return () => ro.disconnect();
  }, [tabs.length]);

  useEffect(() => {
    list.current?.querySelector(`[data-tab-id="${activeId}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId, tabs.length, overflow]);

  // The menu of a tab that has gone (closed with Ctrl+W, moved to another window)
  // would act on the wrong tabs: "Close to the right" closed every tab (BUGS.md UI-2).
  const menuGone = menu !== null && !tabs.some((t) => t.id === menu.id);
  useEffect(() => {
    if (menuGone) setMenu(null);
  }, [menuGone]);

  // Tabs dragged between windows (F2), as in Chrome: the tabs slide apart where a
  // hovering tab would go, a tab dropped here slides into that gap, and the place of
  // a tab torn out of here closes up (or opens again if it could not go).
  useEffect(() => {
    let keepGap: ReturnType<typeof setTimeout> | null = null;
    /** Where the snapped-in tab was last shown, for it to slide from into its place. */
    let shownAt: Phantom | null = null;
    const nodes = () => Array.from(list.current?.children ?? []) as HTMLElement[];
    const showPhantom = (p: Phantom | null) => {
      shownAt = p;
      setPhantom(p);
    };
    const showGap = (index: number | null) => {
      if (keepGap) clearTimeout(keepGap);
      keepGap = null;
      setHoverGapIndex(index);
      const all = nodes();
      const width = all.find((n) => !n.classList.contains("tab-detached"))?.offsetWidth || TAB_WIDTH;
      all.forEach((n, i) => {
        n.style.transform = index !== null && i >= index ? `translateX(${width}px)` : "";
      });
    };
    // Measured with the gap's shifts: a tab moved right counts where it is shown, so
    // the gap stays put until the pointer passes the middle of the next tab.
    const gapAt = (x: number) =>
      insertionIndex(
        nodes().map((n) => {
          const r = n.getBoundingClientRect();
          return r.left + r.width / 2;
        }),
        x,
      );
    const stop = onTabStripNews((news) => {
      switch (news.kind) {
        case "hover": {
          const sc = scroller.current;
          const ls = list.current;
          if (!sc || !ls) break;
          // The tab sits under the mouse where it was grabbed, as wide as the tabs here.
          const shown = nodes().filter((n) => !n.classList.contains("tab-detached"));
          const width = shown[0]?.offsetWidth || TAB_WIDTH;
          const grab = news.grabX === undefined ? width / 2 : news.grabX - stripOrigin(sc, ls);
          const left = news.x - clamp(grab, 12, width - 12);
          const top = shown[0] ? shown[0].getBoundingClientRect().top : ls.getBoundingClientRect().top;
          showGap(gapAt(left + width / 2));
          showPhantom({ left, top, width, title: news.title ?? "", dirty: !!news.dirty });
          break;
        }
        case "leave":
          // Dropped here: hold the gap (and the tab in it) until the tab arrives.
          if (news.dropping && hoverGapIndex() !== null) {
            keepGap = setTimeout(() => {
              showGap(null);
              showPhantom(null);
            }, 1500);
          } else {
            showGap(null);
            showPhantom(null);
          }
          break;
        case "arrived": {
          const ls = list.current;
          const from = shownAt;
          // The tab takes the gap's place: drop the shifts without sliding them back.
          ls?.classList.add("no-anim");
          showGap(null);
          showPhantom(null);
          requestAnimationFrame(() => {
            const el = ls?.querySelector<HTMLElement>(`[data-tab-id="${news.id}"]`);
            if (el && from) {
              // Snapped in under the mouse: it settles from there into its place.
              el.style.transform = `translateX(${from.left - el.getBoundingClientRect().left}px)`;
            } else if (el) {
              el.classList.add("tab-arriving");
              el.addEventListener("animationend", () => el.classList.remove("tab-arriving"), { once: true });
            }
            requestAnimationFrame(() => {
              ls?.classList.remove("no-anim");
              if (el && from) el.style.transform = "";
            });
          });
          break;
        }
        case "stay":
          list.current?.querySelector(`[data-tab-id="${news.id}"]`)?.classList.remove("tab-detached");
          break;
      }
    });
    return () => {
      stop();
      if (keepGap) clearTimeout(keepGap);
      setHoverGapIndex(null);
    };
  }, []);

  const scrollBy = (dx: number) => scroller.current?.scrollBy({ left: dx, behavior: "smooth" });

  const onMenu = useCallback((id: string, x: number, y: number) => {
    setMenu({ id, anchor: { left: x, right: x, top: y, bottom: y } });
  }, []);

  const onPressTab = useCallback((e: PointerEvent<HTMLDivElement>, index: number, id: string) => {
    if (e.button === 1) {
      e.preventDefault(); // no autoscroll cursor
      return;
    }
    if (e.button !== 0) return;
    actions.activate(id);
    focusEditorSoon();
    // A torn-out tab gets a window booted ahead of time, so it never blinks (F2).
    if (useApp.getState().tabs.length > 1) ipc.spareEnsure().catch(() => {});

    const el = e.currentTarget;
    const ls = list.current;
    const sc = scroller.current;
    if (!ls || !sc) return;
    const nodes = Array.from(ls.children) as HTMLElement[];
    const lefts = nodes.map((n) => n.offsetLeft);
    const widths = nodes.map((n) => n.offsetWidth);
    const w = el.offsetWidth;
    const startX = e.clientX;
    /** Where the mouse holds the tab, from its left edge. */
    const grabInTab = e.clientX - el.getBoundingClientRect().left;
    const startScroll = sc.scrollLeft;
    const minDx = -lefts[index];
    const maxDx = lefts[nodes.length - 1] - lefts[index];
    let dragging = false;
    let target = index;
    // Keeps pointer events coming while the mouse is outside the window (F2).
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is only a help; the window listeners below still work inside.
    }

    const move = (ev: globalThis.PointerEvent) => {
      // The button went up where this window did not see it (capture lost, another
      // window took the mouse): end the drag here, or the next click would drop the tab.
      if ((ev.buttons & 1) === 0) {
        end();
        return;
      }
      const raw = ev.clientX - startX + (sc.scrollLeft - startScroll);
      if (!dragging) {
        if (Math.abs(raw) < 5 && Math.abs(ev.clientY - e.clientY) < 5) return;
        dragging = true;
        setTabDragging(true);
        el.classList.add("dragging");
      }
      const strip = sc.getBoundingClientRect();
      if (isPulledOut(strip, ev.clientX, ev.clientY, { width: window.innerWidth, height: window.innerHeight })) {
        // Torn out, as in Chrome: from here on a window follows the mouse, and the
        // tab's place here closes up (F2). Rust follows the mouse from now on.
        end();
        try {
          el.releasePointerCapture?.(e.pointerId);
        } catch {
          // Not captured.
        }
        const { tabs } = useApp.getState();
        // A tab closed or added meanwhile (Ctrl+W with the mouse down): tear nothing.
        if (tabs[index]?.id !== id) return;
        if (tabs.length > 1) el.classList.add("tab-detached");
        // The new window shows the tab where this one shows its first, still under the mouse.
        const grab = { x: stripOrigin(sc, ls) + clamp(grabInTab, 12, TAB_WIDTH - 12), y: e.clientY };
        void actions.detachTab(id, grab);
        return;
      }
      const dx = clamp(raw, minDx, maxDx);
      el.style.transform = `translateX(${dx}px)`;

      if (ev.clientX < strip.left + 16) sc.scrollLeft -= 12;
      else if (ev.clientX > strip.right - 16) sc.scrollLeft += 12;

      target = reorderTarget(lefts, widths, index, dx);
      nodes.forEach((n, i) => {
        if (i === index) return;
        const shift = i > index && i <= target ? -w : i < index && i >= target ? w : 0;
        n.style.transform = shift ? `translateX(${shift}px)` : "";
      });
    };

    /** Stops listening and puts every tab back; true when a drag was under way. */
    const end = (): boolean => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", onKey, true);
      if (!dragging) return false;
      dragging = false;
      setTabDragging(false);
      ls.classList.add("no-anim");
      el.classList.remove("dragging");
      nodes.forEach((n) => {
        n.style.transform = "";
      });
      requestAnimationFrame(() => requestAnimationFrame(() => ls.classList.remove("no-anim")));
      return true;
    };

    const finish = (ev: globalThis.PointerEvent) => {
      if (!end()) return;
      // A tab closed or added during the drag (Ctrl+W with the mouse down) makes the
      // indexes taken at the start wrong: drop nothing rather than move the wrong tab.
      if (useApp.getState().tabs[index]?.id !== id) return;
      if (ev.type === "pointerup" && target !== index) actions.moveTab(index, target);
    };

    // Escape cancels the drag, as in Windows (BUGS.md UI-3).
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape" || !dragging) return;
      ev.preventDefault();
      end();
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        // Not captured.
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      {overflow && (
        <button type="button" className="strip-btn arrow" aria-label="Scroll tabs left" onClick={() => scrollBy(-160)}>
          <Glyph cp={G.left} size={10} />
        </button>
      )}
      <div
        ref={scroller}
        className="tab-scroll"
        style={{ flexBasis: tabs.length * TAB_WIDTH + TAB_LIST_PADDING }}
        onWheel={(e) => {
          if (scroller.current) scroller.current.scrollLeft += e.deltaY;
        }}
      >
        <div ref={list} className="tab-list" role="tablist">
          {tabs.map((t, i) => (
            <Tab key={t.id} tab={t} index={i} active={t.id === activeId} onPressTab={onPressTab} onMenu={onMenu} />
          ))}
        </div>
      </div>
      {overflow && (
        <button type="button" className="strip-btn arrow" aria-label="Scroll tabs right" onClick={() => scrollBy(160)}>
          <Glyph cp={G.right} size={10} />
        </button>
      )}
      <button
        type="button"
        className="strip-btn newtab"
        aria-label="New tab"
        data-tip="New tab"
        onClick={() => {
          actions.newTab();
          focusEditorSoon();
        }}
      >
        <Glyph cp={G.plus} size={12} />
      </button>
      {phantom && (
        <div
          className="tab tab-phantom"
          aria-hidden="true"
          data-active="true"
          data-dirty={phantom.dirty}
          style={{ left: phantom.left, top: phantom.top, width: phantom.width }}
        >
          <span className="tab-title">{phantom.title}</span>
          <span className="tab-close">
            <span className="dot" />
            <Glyph cp={G.closeSmall} size={10} className="x" />
          </span>
        </div>
      )}
      {menu && !menuGone && (
        <Menu
          entries={tabMenu(menu.id)}
          anchor={menu.anchor}
          placement="point"
          width={224}
          onClose={(reason) => {
            setMenu(null);
            if (reason !== "select") focusEditorSoon();
          }}
        />
      )}
    </>
  );
});

export const TitleBar = memo(function TitleBar() {
  return (
    <div className="titlebar">
      <div className="tb-appicon" data-tauri-drag-region="">
        <AppIcon />
      </div>
      <TabStrip />
      <div className="strip-fill" data-tauri-drag-region="" />
      <CaptionButtons />
    </div>
  );
});
