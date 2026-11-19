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
  const tailChars = useApp((s) => activeTab(s)?.tailChars ?? null);
  const progress = useLoadProgress();

  let text: string;
  if (progress) {
    const pct = progress.total > 0 ? Math.min(99, Math.floor((progress.loaded / progress.total) * 100)) : 0;
    text = `Loading… ${pct}%`;
  } else if (!fullyLoaded && tailChars === null) {
    text = "Loading…";
  } else {
    const total = fullyLoaded ? count : count + (tailChars ?? 0);
    text = selected > 0 ? `${fmt(selected)} of ${chars(total)}` : chars(total);
  }

  return (
    <>
      <div className="sb-cell sb-pos">{`Ln ${fmt(line)}, Col ${fmt(col)}`}</div>
      <div className="sb-cell sb-chars div">{text}</div>
    </>
  );
});

const PREVIEW_LIMITED =
  "Live preview is off: a line is longer than 20,000 characters or the file is over 20 MB.";

const ModeCell = memo(function ModeCell() {
  const mode = useApp((s) => activeTab(s)?.mode ?? "plain");
  const limited = useApp((s) => !!s.cursor.previewLimited);

  if (mode === "plain") {
    return (
      <div className="sb-cell sb-mode div">
        <button
          type="button"
          className="sb-btn"
          aria-label="Plain text, switch to Formatted"
          onClick={() => {
            actions.nextMode();
            focusEditorSoon();
          }}
        >
          Plain text
        </button>
      </div>
    );
  }
  const formatted = mode === "formatted";
  // A very long line or a huge file turns live preview off; say so instead of claiming "Formatted".
  const reason = formatted && limited ? PREVIEW_LIMITED : undefined;
  return (
    <div className="sb-cell sb-mode div">
      <button
        type="button"
        className="sb-btn"
        title={reason}
        aria-label={
          reason
            ? `${reason} Switch to Markdown syntax`
            : formatted
              ? "Formatted, switch to Markdown syntax"
              : "Markdown syntax, switch view"
        }
        onClick={() => {
          actions.nextMode();
          focusEditorSoon();
        }}
      >
        {formatted ? <Glyph cp={G.font} size={14} /> : <span className="sb-md">M↓</span>}
        {formatted ? (reason ? "Formatted (preview off)" : "Formatted") : "Markdown syntax"}
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
  extra = [],
}: {
  value: T;
  label: string;
  labels: Record<T, string>;
  cellClass: string;
  onPick: (v: T) => void;
  /** Entries after the choices, below a separator. */
  extra?: MenuEntry[];
}) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const choices: MenuEntry[] = (Object.keys(labels) as T[]).map((k) => ({
    id: k,
    label: labels[k],
    checked: k === value,
    onSelect: () => onPick(k),
  }));
  const entries: MenuEntry[] = extra.length > 0 ? [...choices, { kind: "sep" }, ...extra] : choices;

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

/** Choosing above only changes how the file is saved; this reads it again (BUGS.md M15). */
const REOPEN_ENTRY: MenuEntry = {
  id: "reopen",
  label: "Reopen with encoding",
  submenu: (Object.keys(ENC_LABEL) as Encoding[]).map((k) => ({
    id: `reopen-${k}`,
    label: ENC_LABEL[k],
    onSelect: () => void actions.reopenWithEncoding(k),
  })),
};

const RightCells = memo(function RightCells() {
  const zoom = useApp((s) => s.settings.zoom);
  const eol = useApp((s) => activeTab(s)?.eol ?? "CRLF");
  const encoding = useApp((s) => activeTab(s)?.encoding ?? "utf-8");
  const hasPath = useApp((s) => !!activeTab(s)?.path);
  return (
    <div className="sb-right">
      <div className="sb-cell div sb-zoom">{`${zoom}%`}</div>
      <Picker<Eol> value={eol} label="Line endings" labels={EOL_LABEL} cellClass="sb-eol" onPick={(v) => actions.setEol(v)} />
      <Picker<Encoding>
        value={encoding}
        label="Encoding"
        labels={ENC_LABEL}
        cellClass="sb-enc"
        onPick={(v) => actions.setEncoding(v)}
        extra={hasPath ? [REOPEN_ENTRY] : []}
      />
    </div>
  );
});

export const StatusBar = memo(function StatusBar() {
  const visible = useApp((s) => s.settings.statusBar);
  if (!visible) return null;
  return (
    // Not a live region: role="status" made screen readers read the whole bar after
    // every keystroke and caret move (BUGS.md UI-5).
    <div className="statusbar" role="group" aria-label="Status bar">
      <CursorCells />
      <ModeCell />
      <RightCells />
    </div>
  );
});
