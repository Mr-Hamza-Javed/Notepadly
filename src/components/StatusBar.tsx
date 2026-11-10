import { memo, useRef, useState } from "react";
import type { Encoding, Eol } from "../lib/ipc";
import { actions } from "../state/actions";
import { useApp, useLoadProgress } from "../state/store";
import type { AppState, TabMeta } from "../state/types";
import { G, Glyph } from "./icons";
import { Menu, rectOf, type AnchorRect, type MenuEntry } from "./Menu";
import { focusEditorSoon } from "./focus";

const activeTab = (s: AppState): TabMeta | undefined => s.tabs.find((t) => t.id === s.activeId);

const EOL_LABEL: Record<Eol, string> = { CRLF: "Windows (CRLF)", LF: "Unix (LF)", CR: "Macintosh (CR)" };
const ENC_LABEL: Record<Encoding, string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8 with BOM",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  ansi: "ANSI",
};

const fmt = (n: number) => n.toLocaleString("en-US");
const chars = (n: number) => `${fmt(n)} character${n === 1 ? "" : "s"}`;

/** The only subscriber to the cursor; everything else in the bar stays still while typing. */
const CursorCells = memo(function CursorCells() {
  const line = useApp((s) => s.cursor.line);
  const col = useApp((s) => s.cursor.col);
  const count = useApp((s) => s.cursor.chars);
  const selected = useApp((s) => s.cursor.selected);
  const fullyLoaded = useApp((s) => activeTab(s)?.fullyLoaded ?? true);
  const totalChars = useApp((s) => activeTab(s)?.totalChars ?? null);
  const progress = useLoadProgress();

  let text: string;
  if (progress) {
    const pct = progress.total > 0 ? Math.min(99, Math.floor((progress.loaded / progress.total) * 100)) : 0;
    text = `Loading… ${pct}%`;
  } else if (!fullyLoaded && totalChars === null) {
    text = "Loading…";
  } else {
    const total = fullyLoaded ? count : (totalChars ?? count);
    text = selected > 0 ? `${fmt(selected)} of ${chars(total)}` : chars(total);
  }

  return (
    <>
      <div className="sb-cell sb-pos">{`Ln ${fmt(line)}, Col ${fmt(col)}`}</div>
      <div className="sb-cell sb-chars div">{text}</div>
    </>
  );
});

const ModeCell = memo(function ModeCell() {
  const mode = useApp((s) => activeTab(s)?.mode ?? "plain");

  if (mode === "plain") {
    return (
      <div className="sb-cell sb-mode div">
        <span className="sb-btn static">Plain text</span>
      </div>
    );
  }
  const formatted = mode === "formatted";
  return (
    <div className="sb-cell sb-mode div">
      <button
        type="button"
        className="sb-btn"
        aria-label={formatted ? "Formatted, switch to Markdown syntax" : "Markdown syntax, switch to Formatted"}
        onClick={() => {
          actions.toggleSyntax();
          focusEditorSoon();
        }}
      >
        {formatted ? <Glyph cp={G.font} size={14} /> : <span className="sb-md">M↓</span>}
        {formatted ? "Formatted" : "Markdown syntax"}
      </button>
    </div>
  );
});

function Picker<T extends string>({
  value,
  label,
  labels,
  cellClass,
  onPick,
}: {
  value: T;
  label: string;
  labels: Record<T, string>;
  cellClass: string;
  onPick: (v: T) => void;
}) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const entries: MenuEntry[] = (Object.keys(labels) as T[]).map((k) => ({
    id: k,
    label: labels[k],
    checked: k === value,
    onSelect: () => onPick(k),
  }));

  return (
    <div className={`sb-cell div ${cellClass}`}>
      <button
        ref={btn}
        type="button"
        className="sb-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        data-open={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : rectOf(e.currentTarget))}
      >
        {labels[value]}
      </button>
      {anchor && (
        <Menu
          entries={entries}
          anchor={anchor}
          placement="above-end"
          offset={4}
          width={200}
          compact
          ignore={btn}
          initialActive={Object.keys(labels).indexOf(value)}
          onClose={(reason) => {
            setAnchor(null);
            if (reason !== "select") focusEditorSoon();
          }}
        />
      )}
    </div>
  );
}

const RightCells = memo(function RightCells() {
  const zoom = useApp((s) => s.settings.zoom);
  const eol = useApp((s) => activeTab(s)?.eol ?? "CRLF");
  const encoding = useApp((s) => activeTab(s)?.encoding ?? "utf-8");
  return (
    <div className="sb-right">
      <div className="sb-cell div sb-zoom">{`${zoom}%`}</div>
      <Picker<Eol> value={eol} label="Line endings" labels={EOL_LABEL} cellClass="sb-eol" onPick={(v) => actions.setEol(v)} />
      <Picker<Encoding> value={encoding} label="Encoding" labels={ENC_LABEL} cellClass="sb-enc" onPick={(v) => actions.setEncoding(v)} />
    </div>
  );
});

export const StatusBar = memo(function StatusBar() {
  const visible = useApp((s) => s.settings.statusBar);
  if (!visible) return null;
  return (
    <div className="statusbar" role="status">
      <CursorCells />
      <ModeCell />
      <RightCells />
    </div>
  );
});
