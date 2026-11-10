import { memo, useId } from "react";

/** Segoe Fluent Icons codepoints used by the shell. */
export const G = {
  plus: 0xe710,
  closeSmall: 0xe711,
  captionClose: 0xe8bb,
  captionMin: 0xe921,
  captionMax: 0xe922,
  captionRestore: 0xe923,
  back: 0xe72b,
  left: 0xe76b,
  right: 0xe76c,
  down: 0xe70d,
  up: 0xe70e,
  arrowUp: 0xe74a,
  arrowDown: 0xe74b,
  check: 0xe73e,
  gear: 0xe713,
  help: 0xe897,
  bold: 0xe8dd,
  italic: 0xe8db,
  strike: 0xede0,
  list: 0xe8fd,
  link: 0xe71b,
  table: 0xf58e,
  font: 0xe8d2,
  palette: 0xe790,
  formatting: 0xedc6,
  openFile: 0xe8a7,
  startup: 0xf5a7,
  recent: 0xe823,
  spell: 0xf87b,
  autocorrect: 0xeb7e,
  wrapAround: 0xe8ee,
} as const;

export const Glyph = memo(function Glyph({ cp, size, className }: { cp: number; size?: number; className?: string }) {
  return (
    <span aria-hidden className={className ? `glyph ${className}` : "glyph"} style={size ? { fontSize: size } : undefined}>
      {String.fromCodePoint(cp)}
    </span>
  );
});

/** Notepadly mark: spiral notepad with a Markdown badge. Same art as src-tauri/icons/source. */
export const AppIcon = memo(function AppIcon({ size = 16 }: { size?: number }) {
  // React ids can contain characters that break url(#…) references.
  const id = "nl" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg className="svg-glyph" width={size} height={size} viewBox="170 95 1035 1035" aria-hidden>
      <defs>
        <linearGradient id={`${id}c`} x1="225" y1="150" x2="975" y2="925" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7dd7f1" />
          <stop offset="1" stopColor="#45b0d1" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="610" y1="740" x2="1150" y2="1130" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#5b21b6" />
        </linearGradient>
      </defs>
      <rect x="225" y="850" width="750" height="225" rx="50" fill="#ad602a" />
      <rect x="225" y="820" width="750" height="180" rx="50" fill="#f3f3f3" />
      <rect x="225" y="150" width="750" height="775" rx="50" fill={`url(#${id}c)`} />
      <g fill="#066f94">
        <rect x="300" y="100" width="75" height="125" rx="37.5" />
        <rect x="475" y="100" width="75" height="125" rx="37.5" />
        <rect x="650" y="100" width="75" height="125" rx="37.5" />
        <rect x="825" y="100" width="75" height="125" rx="37.5" />
        <rect x="325" y="400" width="550" height="75" rx="12" />
        <rect x="325" y="550" width="550" height="75" rx="12" />
        <rect x="325" y="700" width="350" height="75" rx="12" />
      </g>
      <rect x="610" y="760" width="540" height="370" rx="80" fill="#ffffff" />
      <rect x="640" y="790" width="480" height="310" rx="58" fill={`url(#${id}b)`} />
      <g fill="none" stroke="#ffffff" strokeWidth="52" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="705,1030 705,860 800,955 895,860 895,1030" />
        <line x1="1010" y1="860" x2="1010" y2="1025" />
        <polyline points="955,972 1010,1030 1065,972" />
      </g>
    </svg>
  );
});

/** "Ab" with an eraser; no matching glyph in Segoe Fluent Icons. */
export const ClearFormatIcon = memo(function ClearFormatIcon() {
  return (
    <svg className="svg-glyph" width="18" height="18" viewBox="0 0 18 18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round">
      <path d="M1.6 10.2 4.6 2.4l3 7.8M2.6 7.7h4" />
      <path d="M10 2v7.4M10 7.4a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 0 0-4.4 0Z" />
      <path d="m8 13.6 4-4a1 1 0 0 1 1.4 0l1.8 1.8a1 1 0 0 1 0 1.4l-3.3 3.2H9.6l-1.6-1.6a.6.6 0 0 1 0-.8ZM10.2 11.4l3 3" />
    </svg>
  );
});

/** Three lines with a return arrow; no matching glyph in Segoe Fluent Icons. */
export const WordWrapIcon = memo(function WordWrapIcon() {
  return (
    <svg className="svg-glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 3h14M1 7.5h11.2a2.3 2.3 0 0 1 0 4.5H8.5M1 12h4.5M10 10.3 8.3 12l1.7 1.7" />
    </svg>
  );
});
