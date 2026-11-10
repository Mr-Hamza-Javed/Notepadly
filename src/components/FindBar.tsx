import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { engine } from "../editor";
import type { FindResult } from "../editor/api";
import { actions } from "../state/actions";
import { useApp } from "../state/store";
import { G, Glyph } from "./icons";

const DEBOUNCE_MS = 120;
const NONE: FindResult = { total: 0, current: 0 };

/** Survives the card closing, as Notepad remembers the last search. */
const memory = { search: "", replace: "", caseSensitive: false, wrap: true };

const FindCard = memo(function FindCard() {
  const find = useApp((s) => s.find);
  const activeId = useApp((s) => s.activeId);
  const [search, setSearch] = useState(memory.search);
  const [replace, setReplace] = useState(memory.replace);
  const [caseSensitive, setCase] = useState(memory.caseSensitive);
  const [wrap, setWrap] = useState(memory.wrap);
  const [result, setResult] = useState<FindResult>(NONE);
  const input = useRef<HTMLInputElement | null>(null);
  const timer = useRef(0);
  const query = useRef({ search, replace, caseSensitive, wrap });
  query.current = { search, replace, caseSensitive, wrap };
  Object.assign(memory, query.current);

  const runNow = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    setResult(query.current.search ? engine.find(query.current) : (engine.clearFind(), NONE));
  }, []);

  const flush = () => {
    if (timer.current) runNow();
  };

  // Ctrl+F while open replaces the `find` object, so this also refocuses the field.
  useEffect(() => {
    const seed = engine.selectionText();
    if (seed && !seed.includes("\n")) {
      setSearch(seed);
      query.current.search = seed;
    }
    input.current?.focus();
    input.current?.select();
  }, [find]);

  // Find needs the whole file, loaded in the background so typing is never blocked.
  useEffect(() => {
    let dead = false;
    runNow();
    void actions.ensureFullyLoaded(activeId).then(() => {
      if (!dead) runNow();
    });
    return () => {
      dead = true;
    };
  }, [activeId, find, runNow]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(runNow, DEBOUNCE_MS);
    return () => window.clearTimeout(timer.current);
  }, [search, replace, caseSensitive, wrap, runNow]);

  const next = () => {
    flush();
    if (query.current.search) setResult(engine.findNext());
  };
  const prev = () => {
    flush();
    if (query.current.search) setResult(engine.findPrev());
  };
  const close = () => {
    window.clearTimeout(timer.current);
    actions.closeFind();
  };

  const onKey = (e: KeyboardEvent, enter: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prev();
      else enter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  let count = "";
  if (search) count = result.total === 0 ? "No results" : `${result.current} of ${result.total}`;
  const noQuery = !search;

  return (
    <div className="findbar" role="search" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }}>
      <div className="find-row">
        <button
          type="button"
          className="icon-btn"
          aria-label={find.replace ? "Hide replace" : "Show replace"}
          data-tip={find.replace ? "Hide replace" : "Show replace"}
          aria-expanded={find.replace}
          onClick={() => actions.openFind(!find.replace)}
        >
          <Glyph cp={find.replace ? G.up : G.down} size={10} />
        </button>
        <div className="find-field">
          <input
            ref={input}
            className="text-input"
            type="text"
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => onKey(e, next)}
          />
          <span className="find-count">{count}</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Previous match" data-tip="Previous (Shift+Enter)" disabled={noQuery} onClick={prev}>
          <Glyph cp={G.arrowUp} size={14} />
        </button>
        <button type="button" className="icon-btn" aria-label="Next match" data-tip="Next (Enter)" disabled={noQuery} onClick={next}>
          <Glyph cp={G.arrowDown} size={14} />
        </button>
        <button type="button" className="icon-btn" aria-label="Match case" aria-pressed={caseSensitive} data-tip="Match case" onClick={() => setCase(!caseSensitive)}>
          Aa
        </button>
        <button type="button" className="icon-btn" aria-label="Wrap around" aria-pressed={wrap} data-tip="Wrap around" onClick={() => setWrap(!wrap)}>
          <Glyph cp={G.wrapAround} size={14} />
        </button>
        <button type="button" className="icon-btn" aria-label="Close" data-tip="Close (Esc)" onClick={close}>
          <Glyph cp={G.closeSmall} size={12} />
        </button>
      </div>
      {find.replace && (
        <div className="find-row">
          <div style={{ width: 32, flex: "none" }} />
          <div className="find-field">
            <input
              className="text-input"
              type="text"
              placeholder="Replace"
              aria-label="Replace"
              spellCheck={false}
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              onKeyDown={(e) =>
                onKey(e, () => {
                  flush();
                  setResult(engine.replaceCurrent());
                })
              }
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={noQuery}
            onClick={() => {
              flush();
              setResult(engine.replaceCurrent());
            }}
          >
            Replace
          </button>
          <button
            type="button"
            className="btn"
            disabled={noQuery}
            onClick={() => {
              flush();
              engine.replaceAll();
              runNow();
            }}
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
});

export const FindBar = memo(function FindBar() {
  const open = useApp((s) => s.find.open);
  return open ? <FindCard /> : null;
});
