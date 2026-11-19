/** What a test hands the e2e page before it loads (see e2e/boot.ts). */
export interface E2eSeed {
  /** Files on the fake disk, by Windows path, as UTF-8 text. */
  files?: Record<string, string>;
  /** Paths opened at start, as if passed on the command line. */
  open?: string[];
  /** Saved settings (localStorage `notepadly.settings.v1`). */
  settings?: Record<string, unknown>;
  /** Answer of `tab_drop_target`: another window under the mouse. */
  dropTarget?: { label: string; x: number; y: number } | null;
}
