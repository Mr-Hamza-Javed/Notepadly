# Notepadly: build spec

A Windows desktop notepad (Tauri 2 + React 19 + TypeScript + CodeMirror 6) that looks like the
Windows 11 Notepad and edits Markdown live the way Obsidian's Live Preview does.
One pane only. There is no split view and no separate preview.

Priorities, in order: **startup and typing speed, low RAM, pixel-accurate Windows 11 look, feature completeness.**

Reference frames from a screen recording of real Notepad are in
`C:\Users\HAMZAJ~1\AppData\Local\Temp\claude\4c147661c5138442\787e9a04-9762-4ff3-85c9-e3a8b83b4a0e\scratchpad\frames\`
(`f_001` File menu dark, `f_002` Recent submenu, `f_004` Edit menu, `f_008`..`f_020` Settings, `f_022` light toolbar,
`f_035` table picker, `f_037` Markdown syntax mode). Some frames show a browser behind the Notepad window: ignore it.

## Contracts (do not change without a compile-breaking reason)
- `src/lib/ipc.ts`: every Rust command, name and shape.
- `src/editor/api.ts`: `EditorEngine` / `EditorHost`. Implementation is exported as `engine` from `src/editor/index.ts`.
- `src/state/types.ts`: `AppState` and friends. Store is `useApp` (zustand) from `src/state/store.ts`.
- `src/state/actions.ts` exports `actions`:

```
init(): Promise<void>                 // restore session, open argv paths, wire engine host
newTab(); openDialog(); openPaths(paths: string[]); openRecent(path); clearRecent()
save(tabId?): Promise<boolean>; saveAs(tabId?): Promise<boolean>; saveAll(): Promise<void>
closeTab(id): Promise<boolean>; closeOthers(id); closeToRight(id); closeWindow(): Promise<void>; exit(): Promise<void>
activate(id); moveTab(fromIndex, toIndex); nextTab(dir: 1 | -1); newWindow()
copyPath(id); revealTab(id); reloadTab(id); keepMine(id)   // keepMine dismisses the external-change bar
setMode(id, mode); toggleSyntax()     // formatted <-> syntax for the active tab
setSetting(key, value); zoomBy(delta); zoomReset()
setEol(eol); setEncoding(enc)         // marks active tab dirty
openFind(replace: boolean); closeFind(); ensureFullyLoaded(id): Promise<void>
insertDateTime(); searchWeb(); print(); showDialog(d); closeDialog(); openSettings(); closeSettings()
applyLink(text, url)
```

## Measurements (CSS px at 100% scale)
| Element | Value |
|---|---|
| Title/tab strip height | 32, tab fills to bottom edge |
| App icon | centred at x=22, 16px |
| Tab | starts x=45, width 233 fixed, shrinks when crowded; top corners radius 8; title 12px semibold; close X at right |
| New tab `+` | 8px after last tab |
| Caption buttons | 46 wide, full strip height, close hover #c42b1c with white glyph |
| Menu bar | 32 high; File/Edit/View 14px, padding 0 8, hover radius 4 |
| Format toolbar | same row as menu bar, horizontally centred in the window |
| Right of menu bar | Settings gear only, at far right |
| Status bar | 30 high, 12px, items separated by 1px dividers |
| Status layout | `Ln 1, Col 1` then `0 characters` at left, then mode (`Formatted`/`Markdown syntax`/`Plain text`) after a divider at x~295, right group `100%`, `Windows (CRLF)`, `UTF-8` starting x~880 / 960 / 1120 proportional from right |
| Dropdown menu | radius 8, 1px border, soft shadow, item height 32, width 224, 14px, shortcuts right-aligned at 12px and dimmer, 1px separators full width, ~4px inset for hover pill |
| Editor text inset | 16px left/right, 16px top |

Colours sampled from the recording:
| Token | Light | Dark |
|---|---|---|
| Title strip (Mica) | #d2dbea | #212121 |
| Active tab, menu bar | #f2f6f9 | #2c2c2c |
| Editor | #f9f9f9 | #282828 |
| Status bar | #f3f4f7 | #2c2c2c |
| Hairline between bars | #eaebed | #1d1d1d |
| Menu surface | #f9f9f9 | #2c2c2c |
| Settings page | #f0f3f8 | #1f1f21 |
| Settings card | #fcfcfe | #2b2b2e |
| Accent | #005fb8 | #60cdff |

Use Windows Mica through Tauri `windowEffects` when available. The strip colours above stand in when it is not.
Icons: the system **Segoe Fluent Icons** font with `Segoe MDL2 Assets` as fallback, by codepoint. No icon library.
UI font: `"Segoe UI Variable Text", "Segoe UI", sans-serif`, also system. No webfonts in the startup path.
App icon: original notepad-style glyph for Notepadly. Product name is Notepadly everywhere, never "Notepad" or Microsoft.
Ignore any house-style or design skill: this app's look is defined here.

## Menus (exact order)
**File**: New tab Ctrl+N, New window Ctrl+Shift+N, Open Ctrl+O, Recent ▸, Save Ctrl+S, Save as Ctrl+Shift+S, Save all Ctrl+Alt+S, ─, Page setup, Print Ctrl+P, ─, Close tab Ctrl+W, Close window Ctrl+Shift+W, Exit.
Recent submenu: up to 10 file names, then `Clear list`.
**Edit**: Undo Ctrl+Z, ─, Cut Ctrl+X, Copy Ctrl+C, Paste Ctrl+V, Delete Del, ─, Search with Bing Ctrl+E, ─, Find Ctrl+F, Find next F3, Find previous Shift+F3, Replace Ctrl+H, Go to Ctrl+G, ─, Select all Ctrl+A, Time/Date F5, ─, Font. Items are disabled when not applicable (no selection, empty doc). Redo is Ctrl+Y and Ctrl+Shift+Z.
**View**: Zoom ▸ (Zoom in Ctrl+Plus, Zoom out Ctrl+Minus, Restore default zoom Ctrl+0), Status bar ✓, Word wrap ✓, Formatting ✓.
Other keys: Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1..9, Ctrl+B, Ctrl+I, Ctrl+K link, Ctrl+wheel zoom. Tab bar: middle-click closes, drag reorders, right-click menu (Close, Close others, Close to the right, Copy path, Reveal in Explorer).

## Tabs and modes
- Dirty tab shows a dot in place of the X; hovering the dot shows the X.
- An untitled tab's title becomes its first line of text (trim `#*-> ` markers, cap 40 chars). Empty means `Untitled`.
- Modes: `formatted` (live preview), `syntax` (raw markdown, monospace not required), `plain` (no markdown parsing at all).
- New tabs and `.md .markdown .mdown .mkd` files: `formatted` when the Formatting setting is on, else `plain`. All other extensions: `plain`.
- Status bar mode label: icon `AA` + `Formatted`, `M↓` + `Markdown syntax`, or `Plain text`. Clicking toggles formatted and syntax. Not clickable in plain.
- Format toolbar is visible only in `formatted`. Contents: H1▾ (Heading 1..6, Body), list▾ (Bulleted, Numbered, Task), B, I, S, link, table▾, clear formatting. Table▾: 5x5 hover grid with "Insert table" label and `Edit table ▸` (insert row above/below, column left/right, delete row/column/table; disabled outside a table).
- Status bar encoding and EOL labels open small pickers calling `setEncoding` / `setEol`.

## Settings page (full window, replaces editor, back arrow top-left)
Big "Settings" title. Left column cards, right column "About this app" (Notepadly, version, no Microsoft text, no feedback or help buttons).
- Appearance: App theme expander (Light, Dark, Use system setting radios).
- Text Formatting: Font expander (Family, Style, Size dropdowns plus a live sample line "The sound of ocean waves calms my soul."), Word wrap toggle (subtitle "Fit text within window by default"), Formatting toggle.
- Opening: Opening files dropdown (Open in a new tab / Open in a new window), When Notepadly starts expander (Continue previous session / Start new session and discard unsaved changes), Recent Files toggle.
- Spelling: Spell check toggle, Autocorrect toggle (subtitle "Typos are automatically corrected when spell check is turned on").
Family comes from `ipc.systemFonts()` loaded on first open. Toggles are WinUI style with "On"/"Off" to the left... of the edge exactly as in the frames.
Defaults: theme system, font Inter (falls back to Segoe UI Variable Text), Medium, 11pt, wrap on, formatting on, tab, continue, recent on, spell off, autocorrect on, status bar on, zoom 100.

## File I/O rules (these are the point of the app)
1. **Never lock a file.** Rust opens, reads the chunk, closes, per call. Every open uses `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`. Other programs can edit, move or delete an open file at any time.
2. **Never read a whole large file up front.** First chunk is 256 KiB, shown immediately. Files at or under 2 MiB finish loading during idle time right after. Larger files load the next 1 MiB chunk only when the viewport is near the loaded end (`onNearEnd`). The whole remainder is loaded only for Ctrl+End, Select all, Find, Replace, Print, or Save-as to a different path, each showing progress in the status bar and never blocking input.
3. **Saving a partial file** sends only the loaded text plus `tailOffset`. Rust streams the remaining original bytes. The tail never enters memory.
4. Chunks are cut on a line boundary when one exists within the chunk, otherwise on a character boundary. Never split a UTF-8 sequence, UTF-16 unit, or CRLF pair.
5. Writes go to a temp file in the same directory then replace the target, preserving attributes. If replace fails because another program has it open, full saves fall back to an in-place write; a tail save copies the temp file over the target in place.
6. External changes: stat all open files on window focus and every 3 s while focused (never a file watcher). Clean tab: reload silently, keeping scroll. Dirty tab: show a thin bar "This file changed on disk" with Reload / Keep mine. Deleted file: bar, tab becomes dirty. A partial save returning `STALE` must never clobber: show a message and offer reload.
7. Character count: exact when fully loaded. While partial, `ipc.scan` runs in the background once and the status bar shows that total.
8. Session: unsaved text goes to drafts (debounce 800 ms, only changed tabs), tab list to session JSON (paths, order, active, mode, scroll). On startup only the active tab is loaded; others stay as metadata until first activated.
9. Hibernation: clean, fully on-disk tabs inactive for 60 s with over 1 MiB loaded drop their editor state, and reload lazily on activate with cursor and scroll restored.

## Performance budgets
- Window visible with content under 300 ms on this machine in a release build. Create the window hidden, show it after first paint, avoid white flash (background set before show).
- Idle RAM target: app process plus WebView2 as low as practical; Rust side under 15 MB.
- Keystroke to paint under 16 ms in a 10 MB markdown file.
- Initial JS under 400 KB gzipped. KaTeX, Mermaid, code-language grammars, `marked` load by dynamic import only when a document needs them. Settings page is a lazy chunk.
- No React re-render of the tree on keystrokes: only StatusBar subscribes to cursor, only Toolbar to format context.
- No work proportional to document length per keystroke anywhere.

## Live Markdown (Obsidian Live Preview behaviour)
Markers hide when the cursor is off that element and reappear when the cursor or selection touches it, per inline element for spans and per line for block markers. Rendered in the same editable surface, always. Only the viewport is decorated.
Full feature list:
- ATX and Setext headings with sized text; bold, italic, bold italic, strikethrough, `==highlight==`, inline code, sub/superscript HTML tags.
- Links `[t](u)`, autolinks, bare URLs, reference links, `[[wikilinks]]` and `[[target|alias]]`. Ctrl+click opens; wikilinks open the sibling `.md` file.
- Images `![alt](src)` and `![[embed.png]]` rendered inline through `convertFileSrc`, relative to the document, with `|width` sizing. Lazy decoded.
- Blockquotes, nested, with bar styling. Callouts `> [!note]` / warning / tip / danger / info / quote etc with icon, tint, title, foldable `[!note]-`.
- Bulleted, numbered, nested lists; bullet widgets; task lists with clickable checkboxes; Enter continues lists, Enter on an empty item ends it, Tab / Shift+Tab indents.
- Horizontal rules; fenced code with language label and syntax highlighting (lazy grammars), indented code.
- GFM tables rendered as real tables when the cursor is outside, raw text when inside, alignment respected, Tab moves between cells.
- Inline `$math$` and block `$$math$$` by KaTeX. ` ```mermaid ` rendered by Mermaid, themed.
- Footnotes `[^1]` and definitions, YAML frontmatter styled as properties block, `%%comments%%` dimmed, `#tags` pills, inline HTML shown as styled source, escapes respected.
Block widgets must come from a StateField (CodeMirror requirement). Update them incrementally: map through changes and rebuild only near the change and the viewport. Never walk the whole tree on each keystroke. Files with lines over 20,000 characters or over 20 MiB loaded fall back to `syntax`-level decoration automatically, without changing the status label.
RTL and Urdu text must render correctly: enable `EditorView.perLineTextDirection`.
