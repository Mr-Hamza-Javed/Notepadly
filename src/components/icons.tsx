import { memo } from "react";
import icon16 from "../assets/app-icon-16.png";
import icon24 from "../assets/app-icon-24.png";
import icon32 from "../assets/app-icon-32.png";

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

/**
 * Notepadly mark, from the PNG files `npm run icons` renders (the same art as the
 * exe icon). The browser picks the file that matches the screen scale, so it stays sharp.
 */
export const AppIcon = memo(function AppIcon({ size = 16 }: { size?: number }) {
  return (
    <img
      className="svg-glyph"
      src={icon16}
      srcSet={`${icon16} 1x, ${icon24} 1.5x, ${icon32} 2x`}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
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
