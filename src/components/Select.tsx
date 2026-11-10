import { useMemo, useRef, useState } from "react";
import { G, Glyph } from "./icons";
import { Menu, rectOf, type AnchorRect, type MenuEntry } from "./Menu";

export interface SelectOption {
  value: string;
  label: string;
}

/** WinUI ComboBox look: custom popup, never a native <select>. */
export function Select({
  value,
  options,
  onChange,
  label,
  onOpen,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  onOpen?: () => void;
}) {
  const btn = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  const open = () => {
    if (!btn.current) return;
    onOpen?.();
    setAnchor(rectOf(btn.current));
  };

  const entries = useMemo<MenuEntry[]>(
    () => options.map((o) => ({ id: o.value, label: o.label, onSelect: () => onChange(o.value) })),
    [options, onChange],
  );

  const current = options.find((o) => o.value === value);
  const width = btn.current?.offsetWidth;

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="select"
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        aria-label={label}
        onClick={() => (anchor ? setAnchor(null) : open())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            open();
          }
        }}
      >
        <span className="select-val">{current?.label ?? value}</span>
        <Glyph cp={G.down} size={10} />
      </button>
      {anchor && (
        <Menu
          entries={entries}
          anchor={anchor}
          offset={2}
          width={width}
          compact
          ignore={btn}
          selectedId={value}
          initialActive={Math.max(0, options.findIndex((o) => o.value === value))}
          onClose={() => {
            setAnchor(null);
            btn.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
