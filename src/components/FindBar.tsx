import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { engine } from "../editor";
import type { FindResult } from "../editor/api";
import { findCountLabel, setFindStepHandler } from "../lib/findBar";
import { actions } from "../state/actions";
import { useApp } from "../state/store";
import { G, Glyph } from "./icons";

const DEBOUNCE_MS = 120;
const NONE: FindResult = { total: 0, current: 0 };

/** Survives the card closing, as Notepad remembers the last search. */
const memory = { search: "", replace: "", caseSensitive: false, wrap: true, wholeWord: false, regexp: false };

const FindCard = memo(function FindCard() {
  const find = useApp((s) => s.find);
  const activeId = useApp((s) => s.activeId);
  const [search, setSearch] = useState(memory.search);
  const [replace, setReplace] = useState(memory.replace);
  const [caseSensitive, setCase] = useState(memory.caseSensitive);
  const [wrap, setWrap] = useState(memory.wrap);
  const [wholeWord, setWholeWord] = useState(memory.wholeWord);
  const [regexp, setRegexp] = useState(memory.regexp);
  const [result, setResult] = useState<FindResult>(NONE);
  /** Replacing needs the whole file: partial text would change only the loaded part (BUGS.md C2). */
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const timer = useRef(0);
  const query = useRef({ search, replace, caseSensitive, wrap, wholeWord, regexp });
  query.current = { search, replace, caseSensitive, wrap, wholeWord, regexp };
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
  // A tab that is not loaded yet is only in the editor once its activation ends, and
  // activating resets the find session, so search again then (BUGS.md M21).
  useEffect(() => {
    let dead = false;
    runNow();
    setLoading(true);
    void actions
      .whenActivated()
      .then(() => {
        if (!dead) runNow();
        return actions.ensureFullyLoaded(activeId);
      })
      .then(() => {
        if (!dead) runNow();
      })
      .catch(() => {})
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [activeId, find, runNow]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(runNow, DEBOUNCE_MS);
    return () => window.clearTimeout(timer.current);
  }, [search, replace, caseSensitive, wrap, wholeWord, regexp, runNow]);

  // In a big document the count finishes after `find` returned (BUGS.md M14).
  useEffect(() => {
    engine.onFindResult?.((next) => {
      if (query.current.search) setResult(next);
    });
    return () => engine.onFindResult?.(null);
  }, []);

  const next = () => {
    flush();
    if (query.current.search) setResult(engine.findNext());
  };
  const prev = () => {
    flush();
    if (query.current.search) setResult(engine.findPrev());
  };
  // F3 / Shift+F3 from anywhere go through the bar, so its counter follows them.
  const stepRef = useRef({ next, prev });
  stepRef.current = { next, prev };
  useEffect(() => {
    setFindStepHandler((dir) => (dir === 1 ? stepRef.current.next() : stepRef.current.prev()));
    return () => setFindStepHandler(null);
  }, []);

  /** Waits for the whole file; false if it cannot be loaded (the loader has said why). */
  const loadAll = async (): Promise<boolean> => {
    const id = activeId;
    try {
      await actions.whenActivated();
      await actions.ensureFullyLoaded(id);
    } catch {
      return false;
    }
    return useApp.getState().activeId === id;
  };
  const replaceOne = async () => {
    if (!(await loadAll())) return;
    flush();
    setResult(engine.replaceCurrent());
  };
  const replaceAll = async () => {
    if (!(await loadAll())) return;
    runNow();
    engine.replaceAll();
    runNow();
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

  const count = search ? findCountLabel(result) : "";
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
          <span className="find-count" role="status">
            {count}
          </span>
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
        <button type="button" className="icon-btn" aria-label="Match whole word" aria-pressed={wholeWord} data-tip="Match whole word" onClick={() => setWholeWord(!wholeWord)}>
          <span style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>ab</span>
        </button>
        <button type="button" className="icon-btn" aria-label="Use regular expression" aria-pressed={regexp} data-tip="Use regular expression" onClick={() => setRegexp(!regexp)}>
          .*
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
                  if (!loading) void replaceOne();
                })
              }
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={noQuery || loading}
            onClick={() => void replaceOne()}
          >
            Replace
          </button>
          <button
            type="button"
            className="btn"
            disabled={noQuery || loading}
            onClick={() => void replaceAll()}
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
