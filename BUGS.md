# Notepadly: bug and edge-case report

**Date:** 10 November 2026 · **Code:** commit `c578712` · **Total:** 70 issues (8 critical, 16 high, 22 medium, 16 low, 8 to check on Windows)

This report covers **functionality**: broken features, wrong results, data loss and unexpected behaviour. No obvious security bug was found, so there is no security section.

## How this was checked

- Read all of the code: Rust backend, state and loader, editor engine, UI components.
- `npm run typecheck` and `npm test` both pass (30 tests).
- Ran the real frontend in Chromium against a fake Tauri backend and reproduced each suspected bug with keyboard and mouse.
- Ran 900 random keystrokes and format commands on `sample.md`: no crash, no exception.

**Limit:** this machine is Linux. The Rust code only compiles on Windows, so Rust bugs were found by reading, not by running. WebView2-only behaviour (clipboard, drag and drop, context menu) is in its own section.

| Mark | Meaning |
| --- | --- |
| ✅ | Reproduced by running the app |
| 📖 | Found by reading the code, not run |
| ⚠️ | Needs a check in the real app on Windows |

---

## Fix these 10 first

| # | Bug | Why first |
| --- | --- | --- |
| C1 | Save As without an extension silently overwrites another file | Data loss |
| C2 | Replace all during loading changes only part of the file | Silent wrong result |
| C3 | Edits in a big file cannot be saved once the file changes on disk | Work is stuck |
| C4 | After an error message, a tab or the window can never close | App is stuck |
| C5 | Session does not come back if the main window closed first | Unsaved notes "vanish" |
| C6 | Urdu/Unicode saved in an ANSI file becomes `?` | Data loss |
| C8 | Typing goes into the previous tab while a tab loads | Wrong file is edited |
| H1 | Ctrl+B in a table cell makes `****text` | Everyday feature broken |
| H2 | Left/Right arrow gets stuck at tables, maths and diagrams | Keyboard navigation broken |
| H9 | Print does not match the screen, and comments are printed | README says otherwise |

---

## CRITICAL: data loss or the app gets stuck

### C1. Save As without an extension renames the file and overwrites another one ✅
- **What happens:** in Save As, pick "All files" and type `LICENSE`. The app adds `.md` (or `.txt`) itself and writes to `LICENSE.md`. If `LICENSE.md` already exists it is **overwritten without asking**, because the Windows dialog only checked `LICENSE`.
- **Test:** `LICENSE.md` held "IMPORTANT EXISTING CONTENT". Save As `C:\d\LICENSE` → its content became "hello".
- **Also:** `.gitignore` becomes `.gitignore.txt`. Files with no extension (`Makefile`, `LICENSE`, `hosts`) can never be saved with Save As.
- **Cause:** `src/state/actions.ts:383` (`withDefaultExtension`), `src/state/logic.ts:198`.
- **Fix:** keep the path the user chose. Add an extension only when the Markdown/Text filter is selected, and ask again if the new name exists.

### C2. "Replace all" before the file has loaded changes only the loaded part ✅
- **What happens:** open a file over 2 MB and press Ctrl+H → Replace all straight away. Only the text in memory at that moment is changed. The rest loads later, unchanged. No warning.
- **Test:** 5.4 MB file with 150,000 "foo". After Replace all: 7,521 replaced, **142,479 left**.
- **Cause:** `src/components/FindBar.tsx:176`. `openFind` starts the full load but Replace all does not wait for it.
- **Fix:** `await actions.ensureFullyLoaded(activeId)` before Replace and Replace all; disable the buttons while loading.

### C3. Edits in a partly loaded big file cannot be saved anywhere once the file changes on disk ✅
- **What happens:** edit a big file, then another program changes it (a logger, a sync tool). Now:
  1. Save → "File changed on disk ... use Save as to keep your text under another name."
  2. Save as → "This file changed on disk while only part of it was loaded. Reload it to continue."
  3. Pressing "Keep mine" first changes nothing.
- The way out the app suggests (Save as) is blocked. Only Reload is left, which throws the edits away.
- **Cause:** `src/lib/loader.ts:219` (`LoadBlockedError`) and `:457` (old stamp kept for a partial tab).
- **Fix:** let Save As write the loaded text plus the tail of the **new** file, or at least offer "save only the loaded text to a new file". Correct the message.

### C4. If a message appears over the "save changes?" dialog, that tab and the window can never close ✅
- **What happens:** the confirm dialog is open and an error message arrives at the same moment (an earlier slow save fails, a background load fails). The message replaces the confirm dialog, but the confirm's promise never resolves.
- **Result:** the tab's X does nothing from then on. If it happened while closing the window, `closeInProgress` stays `true` forever and **the window will not close** (Task Manager only).
- **Test:** both cases reproduced.
- **Cause:** `src/state/store.ts:149`: `showMessage` sets `dialog` directly. `actions.showDialog` handles this case, `showMessage` does not.
- **Fix:** in `showMessage`, resolve a pending `confirm-close` as `cancel` first, or queue messages.

### C5. If the main window is closed first, the session does not come back next time 📖
- **What happens (background mode on, the default):** open 2 windows. Close the **main** one first, then the other. The second window hides in the background. Open Notepadly again: an empty "Untitled", no previous tabs, no unsaved notes.
- **Cause:** only the window labelled `main` restores the session. It has been destroyed, and `src-tauri/src/lib.rs:242` wakes any window that is left. That window has `isMainWindow = false`, so it neither restores nor writes drafts (`src/state/actions.ts:489`, `:515`).
- The notes are still on disk and return after a PC restart, but until then they look lost. New notes written in that window get no draft either.
- **Fix:** create a new `main` window when none exists, or give the last hidden window the main role.

### C6. Saving in ANSI silently turns Urdu/Unicode into `?` 📖
- **What happens:** the file is detected as ANSI (or ANSI is picked in the status bar). Type Urdu, emoji or any letter the code page lacks. On save each one becomes `?`. No warning, and the tab shows as saved.
- **Dangerous path:** one bad byte in the first 256 KB of a UTF-8 file makes the whole file ANSI. Urdu typed into it then becomes `????` for good.
- **Cause:** `src-tauri/src/files.rs:491` (`Unmappable(_) => out.push(b'?')`).
- **Fix:** check before saving and ask the user ("Save as UTF-8?").

### C7. Encoding is detected from the first 256 KB only 📖
- **What happens:** an ANSI file whose first non-ASCII letter comes after 256 KB is treated as UTF-8. Those bytes show as `�` in later chunks. Saving then damages those bytes in the loaded part for good.
- **Cause:** `src-tauri/src/files.rs:174` (`detect_encoding`); later chunks use `from_utf8_lossy`.
- **Fix:** when a later chunk has invalid UTF-8, reload the tab as ANSI, or at least block saving with a warning.

### C8. Typing goes into the previous tab's file while a tab is loading ✅
- **What happens:** click a tab that is not loaded yet (restored from the session, hibernated, or on a slow drive). The tab strip shows the new tab as active at once, but the editor still holds the **previous** file until loading ends. Anything typed in between goes into the previous file and marks it unsaved.
- **Test:** clicked `a.txt` (1.5 s read delay), typed "TYPED" → `b.txt` became "TYPEDBBB file", `a.txt` untouched.
- **Cause:** `src/state/actions.ts:227-238`: `activeId` is set first, `engine.activate` runs after the load.
- **Fix:** show an empty read-only state while loading, or switch `activeId` only when the document is ready.

---

## HIGH: main features broken or wrong results

### H1. Ctrl+B / Ctrl+I / the Bold button in a table cell make `****text` ✅
- Select "apple" in a cell, press Ctrl+B → the document has `| ****apple | 2 |`.
- **Cause:** the global handler in `src/lib/shortcuts.ts:144` runs first (capture phase) and applies bold at the editor's hidden selection (start of the cell). The table's own Ctrl+B code (`widgets.ts:451`) never runs.
- **Fix:** let the table widget handle these keys when focus is in a cell.

### H2. Left/Right arrow gets stuck at rendered tables, maths blocks and Mermaid diagrams ✅
- **What happens:** from the start of the line below a table, press Left. The cursor walks through the hidden source one character at a time and cannot be seen.
- **Test:** crossing a small 2-row table took **58** Left presses. A big diagram takes hundreds.
- **Cause:** `src/editor/livePreview/block.ts` gives no `EditorView.atomicRanges` for its replaced blocks.
- **Fix:** mark block widgets as atomic ranges. Also add a way to enter a table or maths block from the keyboard (only a mouse click works today).

### H3. With a table at the very top of the document, Up arrow then typing scatters the text ✅
- In the header cell press Up, type "abc". "a" landed below the table (and became a new table row), "b" at the end of the document, "c" was lost.
- **Cause:** `src/editor/livePreview/widgets.ts:393`: `anchor = Math.max(0, start - 1)`; position 0 is inside the table.
- **Fix:** when the table starts the document, insert an empty line first and put the cursor there.

### H4. Inserting a table on an empty line swallows the paragraph below it ✅
- `first`, empty line, `second paragraph`. Insert a 2×2 table on the empty line → "second paragraph" becomes the table's third row.
- **Cause:** `src/editor/commands.ts:312` (`suffix`) adds no empty line after the table in this case.
- **Fix:** always add `\n` when the next line is not empty.

### H5. Table commands corrupt a table inside a blockquote or callout ✅
- In a `> | a | b |` table, "Insert row below" → every row becomes `| > | a | b |` and the table leaves the quote.
- **Cause:** `src/editor/commands.ts:221` (`locateTable`) parses from the line start, including `> `.
- **Also:** tables, Mermaid, block maths and `---` inside a list, quote or callout are not rendered at all (`block.ts:143` looks at top-level blocks only), yet the toolbar shows "Edit table" as enabled.
- **Fix:** strip the quote/indent prefix before parsing, or disable the commands for nested tables.

### H6. One long line (over 20,000 characters) turns off live preview for the whole document for good ✅
- Paste a base64 image (`![](data:image/png;base64,...)`) or a minified line. The whole document becomes raw Markdown.
- The status bar still says **"Formatted"** and the toolbar stays. Deleting the line or pressing Undo does not bring it back; the file must be closed and reopened.
- **Cause:** `src/editor/index.ts:323` (`checkDegrade`); the `degraded` flag never clears.
- **Fix:** turn preview back on when the long line is gone; show the reason in the status bar; better, skip only that line.

### H7. A file that is deleted and created again turns a clean tab into "unsaved" ✅
- `git checkout`, OneDrive, or editors that save by delete + rename. The tab is flagged "deleted" and marked unsaved, then when the file is back it shows "This file changed on disk" and asks "save changes?" on close, though the user typed nothing.
- **Cause:** `src/lib/loader.ts:590` forces dirty on `flag-deleted`; `decideExternal` then refuses to reload a dirty tab.
- **Fix:** if the user made no edit, reload silently when the file returns and clear the dirty mark.

### H8. The whole document is written to the draft file after every typing pause ✅
- In a 1.59 MB unsaved file, each "x" wrote a full 1.59 MB draft (4 keystrokes, 4 full writes). For a 100 MB file that is 100 MB over IPC and to disk every 800 ms.
- The spec says "no work proportional to document length per keystroke".
- **Cause:** `src/lib/loader.ts:729`. Save also sends the whole text over IPC.
- **Fix:** a longer debounce for big files, write only the changes, or write during idle time.

### H9. Print does not match the screen, and comments are printed ✅
- README and Help say comments are "left out of printing". In fact `%% secret comment %%` is printed.
- Printed **raw**: `$E=mc^2$`, `$$...$$`, Mermaid (as code), callouts (`[!warning]`), `==highlight==`, `[[wikilink]]`, `#tag`. Front matter prints as a rule and a heading "title: x".
- **Cause:** `src/lib/print.ts:134` uses plain `marked` only.
- **Fix:** remove `%%...%%` and front matter before printing; render KaTeX, Mermaid and callouts into the print HTML.

### H10. The Find "x of y" counter is wrong ✅
1. Move the cursor elsewhere and press Next: on the match at line 40 the counter says **"3 of 50"** (it only adds 1).
2. F3 / Shift+F3 move the match but never update the counter.
3. With 10,000 or more matches: "1 of 10000", then **"0 of 10000"** after Next. It should say "10000+".
- **Cause:** `src/editor/find.ts:197`; `src/lib/shortcuts.ts:123` does not pass the result to the find bar; `FindBar.tsx:93` ignores `FIND_COUNT_LIMIT`.

### H11. Find matches inside tables, block maths and Mermaid cannot be seen ✅
- Search "pear" in a table: the counter says "1 of 1" but nothing is highlighted, so Find seems to do nothing. Replace still works, blind.
- **Cause:** these blocks are replaced by widgets; highlight marks inside them are not drawn.
- **Fix:** open the source or highlight the cell when the match is inside a widget.

### H12. Settings and the Recent list are not shared between windows 📖
- Change the theme, font or startup option in one window: the other open window does not change.
- Each window writes the whole settings object, so the next change in an older window **wipes out** the first window's changes. Same for recent files.
- **Cause:** `src/state/store.ts:111`; there is no `storage` event listener.

### H13. Turning off "Update automatically" does not stop an update that is already downloaded 📖
- If an update is "ready" and the user turns the setting off, it still installs on close.
- **Cause:** `src-tauri/src/autoupdate.rs:208` (`install_if_ready`) does not check `enabled`.

### H14. A file with mixed line endings is fully rewritten on save 📖
- With both CRLF and LF in a file, **every** line is saved in the first line's style. A Git diff shows the whole file changed. No warning; the status bar shows the first line's style only.
- **Cause:** `src-tauri/src/files.rs:458` (`encode_text`).

### H15. Save fails in a folder where new files cannot be created 📖
- The file itself is writable but a temp file cannot be made in its folder (some ACLs, drive roots, some network shares). Save gives "Access is denied" although writing in place would work.
- **Cause:** `src-tauri/src/files.rs:644`. The in-place fallback covers a failed replace, not a failed temp file.

### H16. A file deleted while the app was closed comes back as an empty "unsaved" tab ✅
- The session had `gone.md`; the file was deleted. On start: empty document, dirty dot, "deleted" bar. "Keep mine" + Save writes an **empty file** to disk. Closing asks "save changes?" for an empty document.
- **Cause:** `src/lib/loader.ts:397` (`materialiseOrFlag`).
- **Fix:** do not mark such a tab dirty; ask "file not found, close this tab?".

---

## MEDIUM

### M1. Ctrl+A in a table cell selects the whole document ✅
Focus stays in the cell, the cell text is not selected, the status bar shows "68 of 68 characters". Cause: `src/lib/shortcuts.ts:131`; a table cell is not treated as a native input.

### M2. F5, Ctrl+K and Edit > Paste in a table cell insert at the start of the cell ✅
The caret was at the end of the cell; F5 gave `| 11:50 AM 11/10/2026apple |` (tested). By the code, Ctrl+K and Edit > Paste insert at the same place, and Edit > Copy/Cut do not see the cell's selection (they stay disabled).

### M3. After Ctrl+M the Tab key leaves the editor ✅
Press Ctrl+M by mistake and Tab moves focus to the status bar; typing goes nowhere. Nothing shows that a mode changed. Cause: `src/editor/index.ts:212` keeps CodeMirror's `toggleTabFocusMode` from the default keymap. `Ctrl+/`, `Alt+Arrow`, `Ctrl+[` / `]` and `Ctrl+Shift+K` are also active but hidden.

### M4. Heading and Bold produce wrong Markdown on several lines ✅
- Select all, choose H2 → `## ` on empty lines too, and `## - item`, `## > quote`.
- Select two paragraphs, Bold → `**one\n\ntwo**`, which is not bold.
- Cause: `src/editor/commands.ts:108` and `:44`.

### M5. Moving down out of the last table row marks the document unsaved ✅
With a table at the end of the document, Down arrow or Escape adds a newline and the tab becomes dirty. Cause: `widgets.ts:387`.

### M6. Save As onto the path of another open tab gives two tabs for one file ✅
Both tabs show `a.txt`; saving in one leaves the other in a stale/reload state.

### M7. Links that open wrongly ✅
| Link | What happens |
| --- | --- |
| `[x](report.pdf)`, `[x](photo.png)` | The PDF or image bytes open as garbage in a **text tab** |
| `[[v1.2 notes]]` | `.md` is not added → "Could not open file" |
| `[x](C%23 guide.md)`, `a%26b.md` | `%23`, `%26` are not decoded → file not found |
| `[x](file:///C:/notes/a.md)` | Nothing happens |
| `[x](sub/)` | Tries to open `sub\.md` |
| `[x](/docs/a.md)` | Treated as relative to the document's folder |
Cause: `src/state/logic.ts:145-161` (`decodeURI` leaves reserved characters encoded).

### M8. `.mdx` is Markdown in the installer but plain text in the app ✅
`src-tauri/windows/hooks.nsh` registers `.mdx` as a main Markdown type; `src/state/logic.ts:117` does not list it. It is missing from the Open/Save filters too.

### M9. A file opened during startup can be lost 📖
The `open-paths` listener is added **after** `openHere(pending)` (`src/state/actions.ts:689-690`), while Rust already counts the window as ready. A file opened from Explorer in that gap silently does not open. The close handler is added late as well.

### M10. Odd results with "Open in a new window" 📖
- Open a file from Explorer: a new window appears **and** the main window comes to the front too (when woken from the background, the empty or old-session window shows as well).
- File > Open in an empty window also opens a new window and leaves the empty one.
- Clicking a wikilink opens a new window.
- A file open in another window is not noticed, so one file can be open in two windows.

### M11. Giving a new file name on the command line does nothing 📖
`notepadly newfile.txt` (file does not exist) → empty Untitled. Notepad asks "create a new file?". Launching again while the app runs only focuses the old window; no new tab or window. File names that start with `-` cannot be opened. Cause: `src-tauri/src/lib.rs:229`.

### M12. Hibernation wipes the Undo history 📖
A clean tab over 1 MB that is inactive for 60 seconds has its editor state dropped. On return Ctrl+Z does nothing and callout fold state is reset. Cause: `src/lib/loader.ts:634`.

### M13. Whole-file actions fill memory on very big files 📖
Find, Replace, Select all, Ctrl+End, Print, Save As, Go to line and changing the line ending or encoding all load the full file into RAM. There is no cancel. Above roughly 500 MB `getText()` fails on the JS string limit. Printing 100 MB freezes the UI in `marked.parse`.

### M14. Find scans the whole file on each keystroke in big files 📖
`recount` and `firstFrom` run on the UI thread (120 ms debounce only). In a 100 MB file with few matches the UI can stall on each letter. Cause: `src/editor/find.ts:107`.

### M15. A wrongly detected encoding cannot be corrected 📖
- A UTF-16 file without a BOM is read as UTF-8 (a NUL between every letter).
- Changing the encoding in the status bar only affects **saving**; the file is not decoded again (no "Reopen with encoding").
- A binary file opens as text and is damaged on save, with no warning.
- Only code pages 874, 932, 936, 949, 950 and 1250-1258 are supported; all others (for example 866) are read as windows-1252.

### M16. Edit > Cut deletes the text even when the clipboard write fails 📖
`src/editor/index.ts:611` does not wait for `writeText`. `paste()` (`:623`) has no error handling; if it fails nothing happens and nothing is shown.

### M17. "Exit" does not quit, and the wrong window can be left over 📖
With background mode on, File > Exit only hides the window. With several windows there is a race: sometimes the main window is destroyed and another is left (then C5 applies).

### M18. Extra windows do not remember their session or size 📖
Only the `main` window writes the session and drafts and remembers size and position (`src-tauri/src/lib.rs:285`). Tabs in other windows do not return; every new window opens at 1280×800.

### M19. The Formatting toggle changes every tab; a `.txt` can never be Formatted 📖
- View > Formatting off then on loses the "Markdown syntax" choice of each tab.
- Save an Untitled (Formatted) note as `.txt`: the mode becomes Plain and the status bar cannot switch it back. Markdown inside `.txt`, `.log` and similar files cannot be viewed formatted at all.

### M20. Wrong name in the "could not open" message, and Recent is not cleaned 📖
`src/state/actions.ts:320` always uses the **last** file in the list. The failed file stays in Recent because the entry is "name: error" and never matches a path.

### M21. With the find bar open, moving to an unloaded tab makes F3 say "No results" 📖
Find runs on the old tab's document, then `engine.activate` clears the session. Next does not work until the query is typed again.

### M22. If a restored file cannot be read, the tab is empty 📖
When another program has locked the file, the tab opens empty (partial, offset 0). Text typed there and saved is **added to the start** of the real file. Nothing is lost, but the screen and the disk do not match.

---

## LOW: small bugs and wrong detection

| # | Issue | Status |
| --- | --- | --- |
| L1 | `$HOME/$USER` becomes maths (shows "Use HOME/USER for paths") | ✅ |
| L2 | Colour codes like `#fff`, `#1a2b3c` become tag pills | ✅ |
| L3 | In `if a==b or c==d`, "b or c" is highlighted and the `==` are hidden | ✅ |
| L4 | Time/Date (F5) is always US format `3:05 PM 11/10/2026`, not the system format | ✅ |
| L5 | "characters" counts UTF-16 units (an emoji is 2). The total of a partly loaded unsaved file is stale | 📖 |
| L6 | The font list has false families ("Montserrat Extra"); "Inter" is always listed even when not installed | 📖 |
| L7 | After 400 undo steps, undoing back to the saved state no longer clears the unsaved dot (`index.ts:57`) | 📖 |
| L8 | In table cells `2 * 3 * 4` turns italic; `_x_`, maths, images and wikilinks are not rendered | 📖 |
| L9 | In a table without padding (`\|a\|b\|`), a `\` typed at the end of a cell merges it with the next cell | 📖 |
| L10 | Table commands delete the extra cells of a row that has more cells than the header | 📖 |
| L11 | An unclosed `$$` or `%%` restyles up to 5,000 lines; unclosed front matter up to 1,000 lines | 📖 |
| L12 | Block maths, comment blocks and footnote definitions work at top level only, not inside a list, quote or callout | 📖 |
| L13 | Ctrl+click on links works in Formatted mode only, not in Markdown syntax or Plain | 📖 |
| L14 | `http://` and `file://` images do not show (only `https://`, local paths and data URLs do) | 📖 |
| L15 | In the Find box, Ctrl+B / Ctrl+I / Ctrl+K / F5 act on the document | 📖 |
| L16 | The drafts folder is never cleaned: after a corrupt `session.json` or a crash, draft files stay forever; a draft that cannot be read is deleted | 📖 |

Other small points: Enter on an empty nested list item removes the item instead of outdenting; indenting with Tab does not fix numbering; `pathsEqual` does not understand `..`, 8.3 names or UNC vs mapped drive (one file in two tabs); Ctrl+wheel or pinch zooms 10% per event; a partly loaded file that was deleted first shows "changed" instead of "deleted" (corrects itself within 3 seconds).

---

## ⚠️ To check in the real app on Windows

These look likely from the code but need a run on WebView2.

| # | Suspected problem | Why |
| --- | --- | --- |
| W1 | Selected text cannot be dragged to move it inside the editor | `dragDropEnabled: true` in `tauri.conf.json`; on Windows Tauri then turns off HTML5 drag and drop |
| W2 | Edit > Paste shows a permission popup the first time, or does nothing | `navigator.clipboard.readText()`; clipboard access is not enabled |
| W3 | Right-click on a table border, maths, diagram, image or checkbox shows the WebView2 page menu ("Refresh", "Back", "Save as") | `shortcuts.ts:62` treats everything inside `.cm-content` as text. "Refresh" can drop unsaved work |
| W4 | With Settings, Help or a dialog open, F3 opens WebView2's own find bar | F3 is not in the suppressed list (`shortcuts.ts:45`) |
| W5 | Hovering the maximize button does not show Windows 11 Snap Layouts | Custom caption buttons |
| W6 | The "Autocorrect" setting has no effect | The `autocorrect` attribute does nothing in Chromium |
| W7 | A file that is one line of several MB (minified JSON) is very slow with word wrap | CodeMirror is weak on very long lines; not measured here |
| W8 | Saving on paths over 260 characters, FAT/exFAT USB drives and network shares | `ReplaceFileW` gets the raw path (`files.rs:545`) |

---

## Edge cases: what the app does

| Case | What the app does | OK? |
| --- | --- | --- |
| Empty file | Opens; assumes UTF-8 and CRLF | ✅ |
| 127 MB file | First 256 KB at once, the rest on scroll | ✅ (see C2, C3, M13) |
| File changed by another program, tab clean | Silent reload, scroll kept, Undo history gone | ✅ |
| File changed, tab unsaved | Bar: Reload / Keep mine. Save is refused until Keep mine | ✅ |
| File deleted | Bar, tab marked unsaved. If it comes back, see H7 | ⚠️ |
| File renamed | Treated as deleted | Acceptable |
| Read-only file | Typing works; Save says "Access is denied". No sign beforehand | Weak |
| File locked by another program | "Could not open file" on open; error on save, original kept | ✅ |
| Disk full, or crash during save | Temp file fails, original kept | ✅ |
| Network drive drops | Stat errors ignored, no false flag | ✅ |
| Window not focused | Disk changes are not seen until the window gets focus (no live view side by side) | By design, but unexpected |
| One file in two windows | The second save is refused as stale | ✅ |
| Dropping a folder | "Could not open file" | ✅ |
| Binary file | Garbage text; damaged on save | M15 |
| CR-only line endings | Supported ("Macintosh (CR)") | ✅ |
| Urdu / right-to-left text | Lines are right with `dir="auto"`; table cells get no RTL alignment | Partial |
| Closing the only tab | Closes the window (hides in the background) | Like Notepad |
| App crash or kill | Drafts kept except the last 800 ms (main window only) | ✅ |
| Corrupt `session.json` | New session; old drafts are orphaned (L16) | Weak |
| Typing in the first ~200 ms after start | Text typed before the session is restored can be lost | Small risk |

---

## What works well

- Typecheck is clean and all 30 unit tests pass.
- 900 random keystrokes and format commands caused no exception.
- The no-lock file design, the stale check and the temp-file safe save are carefully built.
- No obvious security bug: a document cannot run scripts (print output is sanitised, KaTeX and Mermaid run in strict mode, table cells escape HTML).
