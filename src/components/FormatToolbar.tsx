import { memo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { engine } from "../editor";
import type { BlockKind, FormatCommand, ListKind } from "../editor/api";
import { actions } from "../state/actions";
import { useApp } from "../state/store";
import { ClearFormatIcon, G, Glyph } from "./icons";
import { Menu, rectOf, type AnchorRect, type MenuEntry } from "./Menu";
import { TablePicker } from "./TablePicker";
import { focusEditorSoon } from "./focus";

const run = (cmd: FormatCommand) => {
  engine.format(cmd);
  focusEditorSoon();
};

const keepEditorFocus = (e: MouseEvent) => e.preventDefault();

function Btn({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="tb-btn" aria-label={label} aria-pressed={active} data-tip={label} data-active={active} onMouseDown={keepEditorFocus} onClick={onClick}>
      {children}
    </button>
  );
}

const BLOCKS: { kind: BlockKind; label: string }[] = [
  { kind: "h1", label: "Heading 1" },
  { kind: "h2", label: "Heading 2" },
  { kind: "h3", label: "Heading 3" },
  { kind: "h4", label: "Heading 4" },
  { kind: "h5", label: "Heading 5" },
  { kind: "h6", label: "Heading 6" },
  { kind: "body", label: "Body" },
];

const LISTS: { kind: ListKind; label: string }[] = [
  { kind: "bullet", label: "Bulleted" },
  { kind: "number", label: "Numbered" },
  { kind: "task", label: "Task" },
];

type Drop = "heading" | "list" | "table";

const ToolbarButtons = memo(function ToolbarButtons() {
  // Field-level selectors: a new format object with the same values renders nothing.
  const block = useApp((s) => s.format.block);
  const list = useApp((s) => s.format.list);
  const bold = useApp((s) => s.format.bold);
  const italic = useApp((s) => s.format.italic);
  const strike = useApp((s) => s.format.strike);
  const link = useApp((s) => s.format.link);
  const inTable = useApp((s) => s.format.inTable);

  const [open, setOpen] = useState<{ which: Drop; anchor: AnchorRect; kbd: boolean } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  const toggle = (which: Drop, el: HTMLElement, kbd: boolean) => {
    setOpen((cur) => (cur?.which === which ? null : { which, anchor: rectOf(el), kbd }));
  };

  const dd = (which: Drop, label: string, active: boolean, body: ReactNode) => (
    <button
      type="button"
      className="tb-btn dd"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open?.which === which}
      data-tip={label}
      data-active={active}
      data-open={open?.which === which}
      data-drop={which}
      onMouseDown={keepEditorFocus}
      onClick={(e) => toggle(which, e.currentTarget, e.detail === 0)}
    >
      {body}
      <Glyph cp={G.down} size={10} />
    </button>
  );

  const close = (reason: string) => {
    setOpen(null);
    if (reason !== "select") focusEditorSoon();
  };

  const headingEntries: MenuEntry[] = BLOCKS.map((b) => ({
    id: b.kind,
    label: b.label,
    checked: block === b.kind,
    onSelect: () => engine.format({ type: "block", kind: b.kind }),
  }));
  const listEntries: MenuEntry[] = LISTS.map((l) => ({
    id: l.kind,
    label: l.label,
    checked: list === l.kind,
    onSelect: () => engine.format({ type: "list", kind: list === l.kind ? "none" : l.kind }),
  }));

  return (
    <div ref={root} className="toolbar" role="toolbar" aria-label="Formatting">
      {dd("heading", "Heading", block !== "body", <span className="tb-h">{block === "body" ? "H1" : block.toUpperCase()}</span>)}
      {dd("list", "List", list !== "none", <Glyph cp={G.list} />)}
      <Btn label="Bold (Ctrl+B)" active={bold} onClick={() => run({ type: "bold" })}>
        <Glyph cp={G.bold} />
      </Btn>
      <Btn label="Italic (Ctrl+I)" active={italic} onClick={() => run({ type: "italic" })}>
        <Glyph cp={G.italic} />
      </Btn>
      <Btn label="Strikethrough" active={strike} onClick={() => run({ type: "strike" })}>
        <Glyph cp={G.strike} />
      </Btn>
      <Btn label="Link (Ctrl+K)" active={link} onClick={() => actions.showDialog({ kind: "link", initialText: engine.selectionText(), initialUrl: "" })}>
        <Glyph cp={G.link} />
      </Btn>
      {dd("table", "Table", inTable, <Glyph cp={G.table} />)}
      <Btn label="Clear formatting" onClick={() => run({ type: "clear" })}>
        <ClearFormatIcon />
      </Btn>

      {open?.which === "heading" && (
        <Menu entries={headingEntries} anchor={open.anchor} placement="below-center" offset={5} width={176} ignore={root} initialActive={open.kbd ? 0 : -1} onClose={close} />
      )}
      {open?.which === "list" && (
        <Menu entries={listEntries} anchor={open.anchor} placement="below-center" offset={5} width={176} ignore={root} initialActive={open.kbd ? 0 : -1} onClose={close} />
      )}
      {open?.which === "table" && <TablePicker anchor={open.anchor} inTable={inTable} ignore={root} onClose={close} />}
    </div>
  );
});

export const FormatToolbar = memo(function FormatToolbar() {
  const formatted = useApp((s) => s.tabs.find((t) => t.id === s.activeId)?.mode === "formatted");
  return formatted ? <ToolbarButtons /> : null;
});
