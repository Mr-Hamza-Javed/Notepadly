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
| C1 | Save As without an extension silently overwrites another file | Data loss — fixed (965dcfc) |
| C2 | Replace all during loading changes only part of the file | Silent wrong result |
| C3 | Edits in a big file cannot be saved once the file changes on disk | Work is stuck — fixed (246833d) |
| C4 | After an error message, a tab or the window can never close | App is stuck |
| C5 | Session does not come back if the main window closed first | Unsaved notes "vanish" |
| C6 | Urdu/Unicode saved in an ANSI file becomes `?` | Data loss — fixed (529593f, a7319a4) |
| C8 | Typing goes into the previous tab while a tab loads | Wrong file is edited |
| H1 | Ctrl+B in a table cell makes `****text` | Everyday feature broken |
| H2 | Left/Right arrow gets stuck at tables, maths and diagrams | Keyboard navigation broken |
| H9 | Print does not match the screen, and comments are printed | README says otherwise |

---

## CRITICAL: data loss or the app gets stuck

### C1. Save As without an extension renames the file and overwrites another one ✅ — fixed (965dcfc)
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

### C3. Edits in a partly loaded big file cannot be saved anywhere once the file changes on disk ✅ — fixed (246833d)
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

### C6. Saving in ANSI silently turns Urdu/Unicode into `?` 📖 — fixed (529593f, a7319a4)
- **What happens:** the file is detected as ANSI (or ANSI is picked in the status bar). Type Urdu, emoji or any letter the code page lacks. On save each one becomes `?`. No warning, and the tab shows as saved.
- **Dangerous path:** one bad byte in the first 256 KB of a UTF-8 file makes the whole file ANSI. Urdu typed into it then becomes `????` for good.
- **Cause:** `src-tauri/src/files.rs:491` (`Unmappable(_) => out.push(b'?')`).
- **Fix:** check before saving and ask the user ("Save as UTF-8?").

### C7. Encoding is detected from the first 256 KB only 📖 — fixed (529593f, a7319a4)
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

### H1. Ctrl+B / Ctrl+I / the Bold button in a table cell make `****text` ✅ — fixed (1887e02)
- Select "apple" in a cell, press Ctrl+B → the document has `| ****apple | 2 |`.
- **Cause:** the global handler in `src/lib/shortcuts.ts:144` runs first (capture phase) and applies bold at the editor's hidden selection (start of the cell). The table's own Ctrl+B code (`widgets.ts:451`) never runs.
- **Fix:** let the table widget handle these keys when focus is in a cell.

### H2. Left/Right arrow gets stuck at rendered tables, maths blocks and Mermaid diagrams ✅ — fixed (1887e02)
- **What happens:** from the start of the line below a table, press Left. The cursor walks through the hidden source one character at a time and cannot be seen.
- **Test:** crossing a small 2-row table took **58** Left presses. A big diagram takes hundreds.
- **Cause:** `src/editor/livePreview/block.ts` gives no `EditorView.atomicRanges` for its replaced blocks.
- **Fix:** mark block widgets as atomic ranges. Also add a way to enter a table or maths block from the keyboard (only a mouse click works today).

### H3. With a table at the very top of the document, Up arrow then typing scatters the text ✅ — fixed (1887e02)
- In the header cell press Up, type "abc". "a" landed below the table (and became a new table row), "b" at the end of the document, "c" was lost.
- **Cause:** `src/editor/livePreview/widgets.ts:393`: `anchor = Math.max(0, start - 1)`; position 0 is inside the table.
- **Fix:** when the table starts the document, insert an empty line first and put the cursor there.

### H4. Inserting a table on an empty line swallows the paragraph below it ✅
- `first`, empty line, `second paragraph`. Insert a 2×2 table on the empty line → "second paragraph" becomes the table's third row.
- **Cause:** `src/editor/commands.ts:312` (`suffix`) adds no empty line after the table in this case.
- **Fix:** always add `\n` when the next line is not empty.

### H5. Table commands corrupt a table inside a blockquote or callout ✅ — fixed (f551dc0)
- In a `> | a | b |` table, "Insert row below" → every row becomes `| > | a | b |` and the table leaves the quote.
- **Cause:** `src/editor/commands.ts:221` (`locateTable`) parses from the line start, including `> `.
- **Also:** tables, Mermaid, block maths and `---` inside a list, quote or callout are not rendered at all (`block.ts:143` looks at top-level blocks only), yet the toolbar shows "Edit table" as enabled.
- **Fix:** strip the quote/indent prefix before parsing, or disable the commands for nested tables.

### H6. One long line (over 20,000 characters) turns off live preview for the whole document for good ✅ — fixed (0bb62e7)
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

### H9. Print does not match the screen, and comments are printed ✅ — fixed (ccacdde, f2a908b)
- README and Help say comments are "left out of printing". In fact `%% secret comment %%` is printed.
- Printed **raw**: `$E=mc^2$`, `$$...$$`, Mermaid (as code), callouts (`[!warning]`), `==highlight==`, `[[wikilink]]`, `#tag`. Front matter prints as a rule and a heading "title: x".
- **Cause:** `src/lib/print.ts:134` uses plain `marked` only.
- **Fix:** remove `%%...%%` and front matter before printing; render KaTeX, Mermaid and callouts into the print HTML.

### H10. The Find "x of y" counter is wrong ✅ — fixed (96a6e76, 7ff58db)
1. Move the cursor elsewhere and press Next: on the match at line 40 the counter says **"3 of 50"** (it only adds 1).
2. F3 / Shift+F3 move the match but never update the counter.
3. With 10,000 or more matches: "1 of 10000", then **"0 of 10000"** after Next. It should say "10000+".
- **Cause:** `src/editor/find.ts:197`; `src/lib/shortcuts.ts:123` does not pass the result to the find bar; `FindBar.tsx:93` ignores `FIND_COUNT_LIMIT`.

### H11. Find matches inside tables, block maths and Mermaid cannot be seen ✅ — fixed (1887e02)
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

### H14. A file with mixed line endings is fully rewritten on save 📖 — fixed (529593f, a7319a4)
- With both CRLF and LF in a file, **every** line is saved in the first line's style. A Git diff shows the whole file changed. No warning; the status bar shows the first line's style only.
- **Cause:** `src-tauri/src/files.rs:458` (`encode_text`).

### H15. Save fails in a folder where new files cannot be created 📖 — fixed (529593f), not checked on Windows
- The file itself is writable but a temp file cannot be made in its folder (some ACLs, drive roots, some network shares). Save gives "Access is denied" although writing in place would work.
- **Cause:** `src-tauri/src/files.rs:644`. The in-place fallback covers a failed replace, not a failed temp file.

### H16. A file deleted while the app was closed comes back as an empty "unsaved" tab ✅
- The session had `gone.md`; the file was deleted. On start: empty document, dirty dot, "deleted" bar. "Keep mine" + Save writes an **empty file** to disk. Closing asks "save changes?" for an empty document.
- **Cause:** `src/lib/loader.ts:397` (`materialiseOrFlag`).
- **Fix:** do not mark such a tab dirty; ask "file not found, close this tab?".

---

## MEDIUM

### M1. Ctrl+A in a table cell selects the whole document ✅ — fixed (1887e02)
Focus stays in the cell, the cell text is not selected, the status bar shows "68 of 68 characters". Cause: `src/lib/shortcuts.ts:131`; a table cell is not treated as a native input.

### M2. F5, Ctrl+K and Edit > Paste in a table cell insert at the start of the cell ✅ — fixed (1887e02)
The caret was at the end of the cell; F5 gave `| 11:50 AM 11/10/2026apple |` (tested). By the code, Ctrl+K and Edit > Paste insert at the same place, and Edit > Copy/Cut do not see the cell's selection (they stay disabled).

### M3. After Ctrl+M the Tab key leaves the editor ✅ — fixed (05bdd86)
Press Ctrl+M by mistake and Tab moves focus to the status bar; typing goes nowhere. Nothing shows that a mode changed. Cause: `src/editor/index.ts:212` keeps CodeMirror's `toggleTabFocusMode` from the default keymap. `Ctrl+/`, `Alt+Arrow`, `Ctrl+[` / `]` and `Ctrl+Shift+K` are also active but hidden.

### M4. Heading and Bold produce wrong Markdown on several lines ✅ — fixed (d573f19, e68b4e5)
- Select all, choose H2 → `## ` on empty lines too, and `## - item`, `## > quote`.
- Select two paragraphs, Bold → `**one\n\ntwo**`, which is not bold.
- Cause: `src/editor/commands.ts:108` and `:44`.

### M5. Moving down out of the last table row marks the document unsaved ✅ — fixed (1887e02)
With a table at the end of the document, Down arrow or Escape adds a newline and the tab becomes dirty. Cause: `widgets.ts:387`.

### M6. Save As onto the path of another open tab gives two tabs for one file ✅ — fixed (246833d)
Both tabs show `a.txt`; saving in one leaves the other in a stale/reload state.

### M7. Links that open wrongly ✅ — fixed (ebb2058)
| Link | What happens |
| --- | --- |
| `[x](report.pdf)`, `[x](photo.png)` | The PDF or image bytes open as garbage in a **text tab** |
| `[[v1.2 notes]]` | `.md` is not added → "Could not open file" |
| `[x](C%23 guide.md)`, `a%26b.md` | `%23`, `%26` are not decoded → file not found |
| `[x](file:///C:/notes/a.md)` | Nothing happens |
| `[x](sub/)` | Tries to open `sub\.md` |
| `[x](/docs/a.md)` | Treated as relative to the document's folder |
Cause: `src/state/logic.ts:145-161` (`decodeURI` leaves reserved characters encoded).

### M8. `.mdx` is Markdown in the installer but plain text in the app ✅ — fixed (ebb2058)
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

### M15. A wrongly detected encoding cannot be corrected 📖 — mostly fixed (529593f, a7319a4)
- A UTF-16 file without a BOM is read as UTF-8 (a NUL between every letter).
- Changing the encoding in the status bar only affects **saving**; the file is not decoded again (no "Reopen with encoding").
- A binary file opens as text and is damaged on save, with no warning.
- Only code pages 874, 932, 936, 949, 950 and 1250-1258 are supported; all others (for example 866) are read as windows-1252.

### M16. Edit > Cut deletes the text even when the clipboard write fails 📖 — fixed (d532e03)
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
| L1 | `$HOME/$USER` becomes maths (shows "Use HOME/USER for paths") | ✅ — fixed (389e22f) |
| L2 | Colour codes like `#fff`, `#1a2b3c` become tag pills | ✅ — fixed (389e22f) |
| L3 | In `if a==b or c==d`, "b or c" is highlighted and the `==` are hidden | ✅ — fixed (389e22f) |
| L4 | Time/Date (F5) is always US format `3:05 PM 11/10/2026`, not the system format | ✅ — fixed (71d6fdf) |
| L5 | "characters" counts UTF-16 units (an emoji is 2). The total of a partly loaded unsaved file is stale | 📖 |
| L6 | The font list has false families ("Montserrat Extra"); "Inter" is always listed even when not installed | 📖 |
| L7 | After 400 undo steps, undoing back to the saved state no longer clears the unsaved dot (`index.ts:57`) | 📖 |
| L8 — fixed in part (7d40ede; rest is TAB-2) | In table cells `2 * 3 * 4` turns italic; `_x_`, maths, images and wikilinks are not rendered | 📖 |
| L9 — fixed (1887e02) | In a table without padding (`\|a\|b\|`), a `\` typed at the end of a cell merges it with the next cell | 📖 |
| L10 — fixed (f551dc0) | Table commands delete the extra cells of a row that has more cells than the header | 📖 |
| L11 | An unclosed `$$` or `%%` restyles up to 5,000 lines; unclosed front matter up to 1,000 lines | 📖 |
| L12 | Block maths, comment blocks and footnote definitions work at top level only, not inside a list, quote or callout | 📖 |
| L13 | Ctrl+click on links works in Formatted mode only, not in Markdown syntax or Plain | 📖 |
| L14 | `http://` and `file://` images do not show (only `https://`, local paths and data URLs do) | 📖 |
| L15 | In the Find box, Ctrl+B / Ctrl+I / Ctrl+K / F5 act on the document | 📖 |
| L8 | In table cells `2 * 3 * 4` turns italic; `_x_`, maths, images and wikilinks are not rendered | 📖 |
| L9 | In a table without padding (`\|a\|b\|`), a `\` typed at the end of a cell merges it with the next cell | 📖 |
| L10 | Table commands delete the extra cells of a row that has more cells than the header | 📖 |
| L11 | An unclosed `$$` or `%%` restyles up to 5,000 lines; unclosed front matter up to 1,000 lines | 📖 — partly fixed (fff807a): an unclosed `$$` ends at the first blank line; unclosed `%%` and front matter unchanged |
| L12 | Block maths, comment blocks and footnote definitions work at top level only, not inside a list, quote or callout | 📖 — fixed (fff807a) |
| L13 | Ctrl+click on links works in Formatted mode only, not in Markdown syntax or Plain | 📖 — fixed (ccbb978) |
| L14 | `http://` and `file://` images do not show (only `https://`, local paths and data URLs do) | 📖 — fixed (249600e) |
| L15 | In the Find box, Ctrl+B / Ctrl+I / Ctrl+K / F5 act on the document | 📖 — fixed (7ff58db) |
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
| W8 | Saving on paths over 260 characters, FAT/exFAT USB drives and network shares | `ReplaceFileW` gets the raw path (`files.rs:545`) — long paths fixed (529593f); FAT/exFAT and shares still to check |

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

---

## Found while writing tests (2026-11)

**Branch:** `test/core-features` · **How:** Vitest (jsdom, real CodeMirror, an in-memory fake of the Rust commands at the IPC boundary) and `cargo test` on Windows. Rust tests ran on this machine this time.

Nothing above was removed. Bugs from the report that a test now pins down are listed first; the tests named `it.skip(...)` / `#[ignore]` reproduce the ones still open (each fails when un-skipped).

### Fixed on this branch (listed bugs)

| # | What was fixed | Commit |
| --- | --- | --- |
| C4 | `showMessage` now answers a pending "save changes?" dialog as Cancel before replacing it, so the tab and the window can close again | `d510cf2` |
| M20 | "Could not open file" names the file that failed, and that file is removed from Recent | `d510cf2` |
| H4 | Inserting a table on a blank line above a paragraph keeps a blank line after the table | `d573f19` |
| M4 (first part) | A heading change over several lines skips blank lines. Bold across paragraphs (second part) is still open | `d573f19` |
| H10 (first part) | Find Next/Previous report the real index after the cursor was moved. Parts 2 (F3 does not update the bar) and 3 ("10000+") are still open | `96a6e76` |
| H9 (part) | `%%comments%%` and front matter are left out of printing. Maths, Mermaid, callouts, highlights, wikilinks and tags still print raw | `ccacdde` |
| L6 (part) | "Montserrat Extra Bold" no longer lists a false "Montserrat Extra"; bitmap `.fon` fonts ("Courier 10,12,15", "MS Sans Serif 8,10,12,14,18,24") are left out. "Inter" is still always listed | `ea5c821`, `fec7557` |
| L8 (part) | Emphasis in table cells needs flanking markers, so `2 * 3 * 4` stays plain; `_x_` is italic. Maths, images and wikilinks in cells are still not rendered (TAB-2) | `7d40ede` |
| H5 | Table commands and Tab keep a table's `> ` quote/callout prefix on every row. Nested tables are still shown as source, not rendered (L12) | `f551dc0` |
| L10 | Table commands keep the extra cells of rows longer than the header | `f551dc0` |
| H1 | A table cell mirrors its caret into the editor selection, so Ctrl+B/I and the toolbar wrap the selected cell text | `1887e02` |
| M2 | F5, Ctrl+K and Edit > Paste insert at the cell caret (escaped so they cannot split the row); Copy/Cut see the cell selection | `1887e02` |
| M1 | Ctrl+A / Edit > Select All in a cell selects the cell's text | `1887e02` |
| H2 | Rendered blocks are atomic ranges; an arrow key that lands on a table's edge enters the table. Maths/Mermaid still open only by double-click or the edit button | `1887e02` |
| H3 | Up in the header of a table at the top of the document stays in the cell | `1887e02` |
| M5 | Down in the last row of a table at the end stays in the cell; Escape adds the line outside the undo history, so the tab stays clean | `1887e02` |
| H11 | A Find match in a table cell is marked in the cell; one in block maths/Mermaid opens its source. Only the current match is shown in a cell (TAB-1) | `1887e02` |
| L9 | A backslash at the end of an unpadded cell gets a space before the pipe | `1887e02` |
| M3 | Ctrl+M (tab focus mode) removed from the editor keymap | `05bdd86` |
| C1 | Save As uses the path the dialog returns (the dialog already adds the selected filter's extension and checks that exact name), so `LICENSE` with "All files" stays `LICENSE` | `965dcfc` |
| T3 | A device name as first line (`con`, `nul`, `com1`...) suggests `con_.md` | `965dcfc` |
| T4 | Trailing dots and spaces are dropped from the chosen Save As name, as Windows does | `965dcfc` |
| M6 | Save As onto a file open in another clean tab closes that tab; if that tab has unsaved changes the save is refused with a message | `246833d` |
| C3 | Save As on a partly loaded file that changed on disk asks to save the loaded part (with the edits) to the new file; the tab then becomes that complete file | `246833d` |
| C6 | A save in ANSI with characters the code page lacks fails in Rust (`UNMAPPABLE`); the app asks: Save as UTF-8 / Save as ANSI (with `?`) / Cancel | `529593f`, `a7319a4` |
| C7 | The background scan reports bytes that are not valid in the encoding; an unedited UTF-8 tab is then read again as ANSI, an edited one gets a warning | `529593f`, `a7319a4` |
| H14 | Unchanged lines of a mixed-line-ending file keep their own ending; changing the line ending in the status bar still converts every line | `529593f`, `a7319a4` |
| H15 | When no temp file can be created (access denied) but the file exists, it is written in place (not atomic). Rust not compiled here | `529593f` |
| M15 (most) | UTF-16 without BOM is detected; status bar Encoding menu has "Reopen with encoding". Still open: no binary-file warning, code pages other than 874/932/936/949/950/1250-1258 | `529593f`, `a7319a4` |
| W8 (part) | Paths of 260+ characters get the `\\?\` prefix before `ReplaceFileW`. FAT/exFAT and network shares still need a Windows check | `529593f` |
| L1, L2, L3 | `$HOME/$USER` is not maths (a closing `$` is never followed by a letter or digit); hex colour codes are not tags; `==` between word characters is not a highlight marker | `389e22f` |
| M4 (second part) | Bold/italic/strike over several paragraphs wraps each paragraph | `e68b4e5` |
| H10 (parts 2, 3), L15 | F3 / Shift+F3 and Edit > Find next/previous go through the find bar, so its counter follows; "1 of 10,000+" with an exact index past the limit; Ctrl+B/I/K and F5 in the Find box no longer edit the document | `7ff58db` |
| M7, M8 | Links: `[[v1.2 notes]]`, `%23`/`%26`, `file://`, folder links, root-relative `/docs/a.md`; PDFs, images and office files open in their default app (opener `openPath`, capability added, not run on Windows). `.mdx` is Markdown | `ebb2058` |
| L14 | `http://` images (CSP `img-src` gains `http:`) and `file://` images, in the editor and in print | `249600e` |
| L4 | F5 uses the locale's short time and date (the WebView's locale, which follows the Windows display language, not the regional format) | `71d6fdf` |
| M16 | Cut deletes only after the clipboard write succeeded; Cut/Copy/Paste failures show a message | `d532e03` |
| L13 | Ctrl+click opens links in Markdown syntax mode, and bare web addresses in Plain | `ccbb978` |
| H6 | Live preview comes back once no long line is left (debounced check after deletions and on tab switch); the status bar says "Formatted (preview off)" with the reason. Skipping only the long line is not done | `0bb62e7` |
| H9 (rest) | Print renders maths (KaTeX), Mermaid, callouts, highlights, wikilinks, embeds and tags | `f2a908b` |
| L12, L11 (part) | `$$`, `%%` and footnote definitions work inside lists, quotes and callouts (the live preview still draws block widgets at top level only); an unclosed `$$` ends at a blank line | `fff807a` |

### Fixed on this branch (new)

#### T1. Choosing a heading or list kind at the start of a line puts the cursor before the marker ✅ (fixed in `d573f19`)
- **What happened:** on an empty line (or with the cursor at the start of a line), pick H1 or "Bulleted list", then type "x". The line became `x# ` / `x- ` instead of `# x` / `- x`.
- **Cause:** `src/editor/commands.ts` (`setBlockKind`, `setListKind`) inserted the marker at the cursor position, and a cursor at an insertion point stays in front of it.
- **Fix:** a bare cursor at the insertion point is mapped to after the new marker. Test: `commands.test.ts` "puts a cursor at the start of the line after the new marker".

### Still open, with a skipped test

| # | Test |
| --- | --- |
| H5 — fixed, test un-skipped (f551dc0) | `src/editor/commands.test.ts` "H5: adding a row to a table inside a blockquote keeps it in the quote" |
| H7 | `src/state/actions.test.ts` "H7: a deleted-then-restored file leaves an unedited tab clean" |
| H14 | `src-tauri/src/files.rs` `mixed_line_endings_are_kept_on_save` (`#[ignore]`) — fixed (529593f), test runs again |
| H16 | `src/state/actions.test.ts` "H16: a restored tab whose file is gone is not an empty unsaved document" |
| M4 (second part) — fixed, test un-skipped (e68b4e5) | `src/editor/commands.test.ts` "M4: bolding two paragraphs bolds each one" |
| M7 — fixed, test un-skipped (ebb2058) | `src/state/logic.test.ts` "M7: [[v1.2 notes]] opens v1.2 notes.md" |
| M12 | `src/lib/loader.test.ts` "M12: undo still works after a tab was hibernated and woken" |
| M15 | `src-tauri/src/files.rs` `utf16_without_bom_is_detected` (`#[ignore]`) — fixed (529593f), test runs again |
| L2, L3 — fixed, tests un-skipped (389e22f) | `src/editor/markdown.test.ts` "L2: colour codes are not tags", "L3: comparison operators are not highlight markers" |
| L8 — fixed, test un-skipped (7d40ede) | `src/editor/tableModel.test.ts` "L8: 2 * 3 * 4 stays plain text" |

### New, not fixed

#### T2. An untitled tab closed right after typing comes back named "Untitled" ✅
- **What happens:** type the first line of a new note and close the window within a quarter of a second. Next start the tab has its text and its draft, but the tab is called "Untitled" until the next edit.
- **Steps:** new tab, type `Shopping list`, close the window at once (background mode, continue session), start again.
- **Expected:** title "Shopping list". **Actual:** "Untitled".
- **Cause:** `src/state/actions.ts:49` / `:85` (`scheduleTitle`): the title is set on a 250 ms timer, and `prepareWindowClose` (`:484`) stores the session without running a pending title update. The test in `actions.test.ts` waits for the title before closing to stay deterministic.
- **Fix:** flush pending title timers in `prepareWindowClose`, or derive the title in `buildSession` for untitled dirty tabs.

#### T3. A note whose first line is a Windows device name suggests an invalid file name 📖 — fixed (965dcfc)
- **What happens:** an untitled tab whose first line is `con`, `nul`, `aux`, `prn`, `com1`..`com9` or `lpt1`..`lpt9` suggests `con.md` etc. in Save As. Windows reserves these names with any extension, so the dialog refuses or the save fails.
- **Expected:** a usable suggestion (`con_.md` or `Untitled.md`). **Actual:** `con.md`.
- **Cause:** `src/state/logic.ts:192` (`suggestedFileName`) strips forbidden characters but not reserved names.

#### T4. A Save As name ending in a dot keeps a "." extension that Windows then drops 📖 — fixed (965dcfc)
- **What happens:** in Save As type `notes.` → `extOf` sees the extension `.`, so no `.md`/`.txt` is added. Windows strips the trailing dot and writes `notes` with no extension, while the tab's path stays `...\notes.`. `pathsEqual` then treats `notes.` and `notes` as different files, so opening `notes` again gives a second tab for the same file.
- **Cause:** `src/state/logic.ts:111` (`extOf`) and `:198` (`withDefaultExtension`); related to C1.
- **Fix:** trim trailing dots and spaces from the chosen path before using it (Windows does the same).

### Could not be checked here
- The fake backend follows `files.rs`, but it is not Rust. Rust behaviour itself is covered by `cargo test` (56 passing, 2 ignored as known bugs).
- Layout-dependent behaviour (cursor movement across widgets, H2; drag and drop; clipboard; WebView2 menus W1–W8) cannot run in jsdom and was not tested.
- The auto-updater's network, download and install path needs a real `AppHandle` and GitHub; only the resume marker and status wire format are tested. H13 stays open.

---

## Missing features (to add when fixing bugs)

These are not bugs in existing code: Windows Notepad does these things and Notepadly does not. Add them together with the window bugs they touch.

### F1. Launching the app again only brings back the old window; it should open a new window 📖
- **What happens:** while Notepadly is running, starting it again from the Start menu, taskbar, a shortcut or the command line does not open anything new. The running window is shown and focused again.
- **Expected (as in Notepad):** every new launch opens a **new window**. The windows that are already open stay as they are.
- **Cause:** the app uses `tauri-plugin-single-instance` (`src-tauri/src/lib.rs:276`). `on_second_instance` (`src-tauri/src/lib.rs:238`) only sends the paths to the main window, then runs `unminimize`, `show` and `set_focus`.
- **To do:** in `on_second_instance`, open a new window when there are no paths, the same way `window_new` does. When a file is opened from Explorer, still follow the "Open files in" setting (`openFilesIn`: tab or window). Keep the single process, so drafts, the session and settings stay in one place.
- **Related:** M10, M11, M17 and M18 (extra windows do not remember their session or size). Once every launch makes a window, M18 and H12 (settings and Recent not shared between windows) matter much more, so fix them with this.

### F2. Tabs cannot be dragged out to a new window or between windows 📖
- **What happens:** tabs can only be reordered or used inside their own window.
- **Expected (as in Notepad):**
  - Drag a tab out of the tab bar and drop it outside the window: that tab opens in a **new window** of its own and leaves the old window.
  - Drag a tab from one window and drop it on another window's tab bar: the tab **moves** into that window at the drop position.
  - The moved tab keeps everything: its text, unsaved changes, undo history if possible, cursor and scroll position, encoding, line endings and mode. It must never be saved or reloaded from disk because of the move.
  - Dragging the last tab out of a window moves the whole window, so no empty window is left behind.
- **Cause:** the tab bar has no drag-out handling, and there is no Rust command that moves a tab's state from one window to another. Each window keeps its own tab list (`src/state/store.ts`), and only the `main` window writes the session (see M18).
- **To do:**
  - Add a `tab_move` command: the source window sends the tab's full state (or saves its draft first), Rust creates or targets the window, and the target window loads it.
  - Use the drag position on screen to tell a drop outside every window (new window) from a drop on another window's tab bar (move).
  - Make sure the moved tab's draft and session entry belong to the new window, so nothing is lost or duplicated on restart.
- **Related:** M18, C5 and H12. Test the move with a dirty tab, a partly loaded big file and an untitled tab.

### New (tables)

#### TAB-1. Only the current Find match is shown inside a table cell 📖
- **What happens:** search a word that appears in several table cells. The current match is marked in its cell, but the other matches in tables get no yellow highlight (matches in normal text do).
- **Cause:** `src/editor/livePreview/widgets.ts` `TableController.showSelection` marks the editor selection only; the `cm-find-match` marks of `src/editor/find.ts` are drawn by CodeMirror and cannot reach the widget's cells.
- **Fix:** pass the find query to the table widgets and mark every match in the rendered cells.

#### TAB-2. Maths, images and wikilinks are not rendered in table cells (rest of L8) 📖
- `src/editor/livePreview/widgets.ts` `renderCellHtml` handles bold/italic/strike/highlight/code/links only.

#### TAB-3. Emphasis rules run inside a link target in a table cell 📖
- **Steps:** a cell `[x](https://a.b/_c_/d)` or `[x](https://a.b/*c*)`.
- **Actual:** the URL in `data-href` gets `<em>` tags, so the link is broken. **Expected:** the target is left as written.
- **Cause:** `renderCellHtml` (`src/editor/livePreview/widgets.ts`) replaces emphasis before links; links should be swapped out first, like code spans.

#### TAB-4. Escape in a table at the end of a partly loaded file adds a newline in the middle of the file 📖
- **Steps:** open a big file that loads in parts, where the loaded part ends inside a table; click a cell of the last row and press Escape before the rest loads.
- **Cause:** `TableController.leave` (`src/editor/livePreview/widgets.ts`) adds a `\n` at the end of the document (outside the undo history, so the tab stays clean); the loader then appends the next chunk after it. The extra newline is saved with the next real edit.
- **Fix:** skip the newline (stay in the cell) while the tab is not fully loaded.

### New (files)

#### FILES-1. A mixed-line-ending file cannot be normalised to its first line's style 📖
- **What happens:** the file starts with CRLF but also has LF lines. Picking "Windows (CRLF)" in the status bar does nothing (it is already shown), so the LF lines stay. Since H14 is fixed, a save keeps them too. Workaround: pick LF, then CRLF.
- **Cause:** `src/state/actions.ts` `changeFileFormat` returns early when the picked line ending equals `tab.eol`; the frontend does not know the file is mixed.
- **Fix:** let Rust report "mixed" in `FileChunk`, show it in the status bar, and let picking any style normalise.

#### FILES-2. A UTF-16 file without a BOM gets a BOM when saved 📖
- **What happens:** since M15, such a file is read as UTF-16, but `save` always writes `Encoding::bom()`, so the first save adds `FF FE` / `FE FF` and the file grows by 2 bytes.
- **Cause:** `src-tauri/src/files.rs` `save` / `write_in_place`; the encoding enum has no "UTF-16 without BOM".
- **Fix:** probably fine (Notepad also writes a BOM), but could add BOM-less UTF-16 variants if it matters.

#### FILES-3. The H15 in-place fallback is not atomic 📖
- **What happens:** when the folder allows no new files, the file is overwritten in place. If the write fails part way (disk full, network drop), the file is damaged and no temp copy exists.
- **Cause:** `src-tauri/src/files.rs` `write_in_place`. Notepad has the same limit.

### New (markdown)

#### MD-1. Maths and Mermaid inside a list, quote or callout show as source in Formatted mode 📖
- **What happens:** since L12, `$$` blocks inside a list or quote are parsed as maths, but the live preview only turns top-level blocks into widgets, so they show as styled source (Print renders them).
- **Cause:** `src/editor/livePreview/block.ts` (block widgets are built for children of `Document` only, the same limit as tables in H5).

#### MD-2. The real regional date/time format is not available to F5 📖
- **What happens:** L4 now uses the WebView's locale, which follows the Windows display language. With an English UI and a UK or German region, F5 still gives the US order.
- **Fix:** read the user's locale name in Rust (`GetUserDefaultLocaleName`) and pass it to `formatDateTime`.
