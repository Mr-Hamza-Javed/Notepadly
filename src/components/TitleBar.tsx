import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { actions } from "../state/actions";
import { useApp } from "../state/store";
import type { TabMeta } from "../state/types";
import { AppIcon, G, Glyph } from "./icons";
import { Menu, type AnchorRect, type MenuEntry } from "./Menu";
import { CaptionButtons } from "./CaptionButtons";
import { focusEditorSoon } from "./focus";

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
        tabIndex={active ? 0 : -1}
        aria-label={`Close ${tab.title}`}
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
    { id: "close", label: "Close", onSelect: () => void actions.closeTab(id) },
    { id: "others", label: "Close others", disabled: tabs.length < 2, onSelect: () => void actions.closeOthers(id) },
    { id: "right", label: "Close to the right", disabled: index >= tabs.length - 1, onSelect: () => void actions.closeToRight(id) },
    { kind: "sep" },
    { id: "copy", label: "Copy path", disabled: !hasPath, onSelect: () => void actions.copyPath(id) },
    { id: "reveal", label: "Reveal in Explorer", disabled: !hasPath, onSelect: () => void actions.revealTab(id) },
  ];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Flex would otherwise size the scroller from tab content, not the 233px basis. */
const TAB_WIDTH = 233;
/** .tab-list side padding, room for the active tab's flare without overflowing. */
const TAB_LIST_PADDING = 8;

const TabStrip = memo(function TabStrip() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const scroller = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [menu, setMenu] = useState<{ id: string; anchor: AnchorRect } | null>(null);

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

    const el = e.currentTarget;
    const ls = list.current;
    const sc = scroller.current;
    if (!ls || !sc) return;
    const nodes = Array.from(ls.children) as HTMLElement[];
    const lefts = nodes.map((n) => n.offsetLeft);
    const w = el.offsetWidth;
    const startX = e.clientX;
    const startScroll = sc.scrollLeft;
    const minDx = -lefts[index];
    const maxDx = lefts[nodes.length - 1] - lefts[index];
    let dragging = false;
    let target = index;

    const move = (ev: globalThis.PointerEvent) => {
      const raw = ev.clientX - startX + (sc.scrollLeft - startScroll);
      if (!dragging) {
        if (Math.abs(raw) < 5) return;
        dragging = true;
        el.classList.add("dragging");
      }
      const dx = clamp(raw, minDx, maxDx);
      el.style.transform = `translateX(${dx}px)`;

      const box = sc.getBoundingClientRect();
      if (ev.clientX < box.left + 16) sc.scrollLeft -= 12;
      else if (ev.clientX > box.right - 16) sc.scrollLeft += 12;

      const center = lefts[index] + dx + w / 2;
      target = index;
      for (let i = 0; i < nodes.length; i++) {
        if (i === index) continue;
        const mid = lefts[i] + nodes[i].offsetWidth / 2;
        // Inclusive: dragging past the end clamps the centre onto the last tab's midpoint.
        if (i > index && center >= mid) target = Math.max(target, i);
        if (i < index && center <= mid) target = Math.min(target, i);
      }
      nodes.forEach((n, i) => {
        if (i === index) return;
        const shift = i > index && i <= target ? -w : i < index && i >= target ? w : 0;
        n.style.transform = shift ? `translateX(${shift}px)` : "";
      });
    };

    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (!dragging) return;
      ls.classList.add("no-anim");
      el.classList.remove("dragging");
      nodes.forEach((n) => {
        n.style.transform = "";
      });
      if (target !== index) actions.moveTab(index, target);
      requestAnimationFrame(() => requestAnimationFrame(() => ls.classList.remove("no-anim")));
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
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
      {menu && (
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
