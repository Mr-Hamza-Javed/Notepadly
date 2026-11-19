import { describe, expect, it } from "vitest";
import {
  classifyHref,
  clampZoom,
  computeDark,
  decideExternal,
  defaultModeFor,
  deriveTitle,
  dirOf,
  extOf,
  fileNameOf,
  fontStack,
  fontWeightOf,
  formatDateTime,
  headerFooterBoxes,
  isMarkdownPath,
  loadedOffsetAfterPartialSave,
  modeAfterSave,
  moveItem,
  neighbourAfterClose,
  parseSession,
  pathsEqual,
  pushRecent,
  resolveRelative,
  sanitizePageSetup,
  sanitizeRecent,
  sanitizeSettings,
  saveFilters,
  stampsEqual,
  suggestedFileName,
  tabFromSession,
  chosenSavePath,
  wrapIndex,
  DEFAULT_PAGE_SETUP,
  DEFAULT_SETTINGS,
  MAX_RECENT,
  type SessionTab,
} from "./logic";

describe("settings", () => {
  it("falls back to defaults for missing or invalid values", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ theme: "purple", zoom: 9999, fontSizePt: 1, wordWrap: "yes" });
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.zoom).toBe(500);
    expect(s.fontSizePt).toBe(6);
    expect(s.wordWrap).toBe(DEFAULT_SETTINGS.wordWrap);
  });

  it("clamps zoom to 10..500", () => {
    expect(clampZoom(5)).toBe(10);
    expect(clampZoom(123.6)).toBe(124);
    expect(clampZoom(900)).toBe(500);
  });
});

describe("paths", () => {
  it("splits Windows and POSIX paths", () => {
    expect(fileNameOf("C:\\notes\\a.md")).toBe("a.md");
    expect(fileNameOf("/home/u/b.txt")).toBe("b.txt");
    expect(dirOf("C:\\notes\\a.md")).toBe("C:\\notes");
    expect(extOf("C:\\notes\\README.MD")).toBe(".md");
    expect(extOf("C:\\notes\\.gitignore")).toBe("");
  });

  it("compares paths ignoring case and separators", () => {
    expect(pathsEqual("C:\\Notes\\A.md", "c:/notes/a.md")).toBe(true);
    expect(pathsEqual("C:\\a.md", null)).toBe(false);
  });

  it("resolves relative paths", () => {
    expect(resolveRelative("C:\\notes\\sub", "../img/x.png")).toBe("C:\\notes\\img\\x.png");
    expect(resolveRelative("C:\\notes", "D:\\abs.md")).toBe("D:\\abs.md");
  });
});

describe("links", () => {
  it("only lets web and mail links reach the system opener", () => {
    expect(classifyHref("https://example.com", null)).toEqual({ kind: "web", url: "https://example.com" });
    expect(classifyHref("mailto:a@b.c", null).kind).toBe("web");
    expect(classifyHref("javascript:alert(1)", "C:\\n").kind).toBe("none");
    // A file:// link opens the file in a tab (BUGS.md M7); it never reaches the system opener.
    expect(classifyHref("file:///C:/x", "C:\\n")).toEqual({ kind: "file", path: "C:\\x.md" });
    expect(classifyHref("ms-settings:", "C:\\n").kind).toBe("none");
  });

  it("resolves wikilinks to sibling markdown files", () => {
    expect(classifyHref("wikilink:Another note", "C:\\notes")).toEqual({
      kind: "file",
      path: "C:\\notes\\Another note.md",
    });
    expect(classifyHref("wikilink:Note#Heading", "C:\\notes")).toEqual({ kind: "file", path: "C:\\notes\\Note.md" });
    expect(classifyHref("wikilink:Note", null).kind).toBe("none");
  });
});

describe("modes and titles", () => {
  it("picks formatted mode for markdown and new tabs", () => {
    expect(defaultModeFor(null, true)).toBe("formatted");
    expect(defaultModeFor("a.md", true)).toBe("formatted");
    expect(defaultModeFor("a.txt", true)).toBe("plain");
    expect(defaultModeFor("a.md", false)).toBe("plain");
  });

  it("keeps syntax view when saving under a markdown name", () => {
    expect(modeAfterSave("syntax", "b.md", true)).toBe("syntax");
    expect(modeAfterSave("formatted", "b.txt", true)).toBe("plain");
  });

  it("derives untitled tab titles from the first line", () => {
    expect(deriveTitle("# My heading")).toBe("My heading");
    expect(deriveTitle("- [ ]")).toBe("[ ]");
    expect(deriveTitle("   ")).toBe("Untitled");
    expect(deriveTitle("x".repeat(80))).toHaveLength(40);
  });

  it("suggests a safe file name", () => {
    expect(suggestedFileName({ path: null, title: 'a:b*c?"', mode: "formatted" })).toBe("abc.md");
    expect(suggestedFileName({ path: null, title: "notes", mode: "plain" })).toBe("notes.txt");
    expect(suggestedFileName({ path: "C:\\x\\y.md", title: "ignored", mode: "plain" })).toBe("y.md");
  });

  it("formats Time/Date like Notepad", () => {
    expect(formatDateTime(new Date(2026, 10, 10, 0, 5), "en-US")).toBe("12:05 AM 11/10/2026");
    expect(formatDateTime(new Date(2026, 0, 2, 13, 30), "en-US")).toBe("1:30 PM 1/2/2026");
  });

  // BUGS.md L4: F5 used the US format everywhere.
  it("formats Time/Date in the user's own format", () => {
    const d = new Date(2026, 10, 10, 15, 5);
    expect(formatDateTime(d, "en-GB")).toBe("15:05 10/11/2026");
    expect(formatDateTime(d, "de-DE")).toBe("15:05 10.11.2026");
    expect(formatDateTime(d, "en-US")).toBe("3:05 PM 11/10/2026");
  });
});

describe("tabs and recent files", () => {
  it("moves items and wraps indexes", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(3, 3)).toBe(0);
  });

  it("activates the right neighbour after closing, else the left", () => {
    expect(neighbourAfterClose(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourAfterClose(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourAfterClose(["a"], "a")).toBeNull();
  });

  it("keeps recent files unique and capped", () => {
    const list = Array.from({ length: MAX_RECENT }, (_v, i) => `C:\\f${i}.md`);
    const next = pushRecent(list, "c:/F3.md");
    expect(next[0]).toBe("c:/F3.md");
    expect(next).toHaveLength(MAX_RECENT);
    expect(next.filter((p) => pathsEqual(p, "C:\\f3.md"))).toHaveLength(1);
  });
});

describe("file safety", () => {
  it("computes the loaded offset after a partial save", () => {
    // 1000-byte file, 400 bytes loaded and edited to 450 bytes: tail is 600.
    expect(loadedOffsetAfterPartialSave(1050, 1000, 400)).toBe(450);
    expect(loadedOffsetAfterPartialSave(100, 1000, 1200)).toBeNull();
  });

  const stamp = { size: 10, mtimeMs: 1 };
  const changed = { size: 12, mtimeMs: 2 };

  it("reloads a clean tab when the file changes on disk", () => {
    expect(decideExternal({ stamp, dirty: false, externalChange: null }, changed, null, true)).toBe("reload");
  });

  it("never overwrites unsaved edits when the file changes on disk", () => {
    expect(decideExternal({ stamp, dirty: true, externalChange: null }, changed, null, true)).toBe("flag-modified");
  });

  it("flags a deleted file and respects Keep mine", () => {
    expect(decideExternal({ stamp, dirty: false, externalChange: null }, null, null, true)).toBe("flag-deleted");
    expect(decideExternal({ stamp, dirty: true, externalChange: null }, changed, changed, true)).toBe("none");
  });
});

describe("session", () => {
  it("rejects corrupt session files", () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession("{not json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("settings: stored values are never trusted", () => {
  it("keeps a complete valid settings object as it is", () => {
    const valid = { ...DEFAULT_SETTINGS, theme: "dark", zoom: 150, fontFamily: "Noto Nastaliq Urdu", startup: "new" };
    expect(sanitizeSettings(valid)).toEqual(valid);
  });

  it("drops unknown keys from older or newer versions", () => {
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, removedFeature: true })).toEqual(DEFAULT_SETTINGS);
  });

  it("fills in settings added since the file was written", () => {
    const old = { theme: "light", zoom: 120 };
    expect(sanitizeSettings(old)).toEqual({ ...DEFAULT_SETTINGS, theme: "light", zoom: 120 });
  });

  it("replaces non-finite and wrongly typed numbers with defaults", () => {
    for (const zoom of [NaN, Infinity, "150", null]) {
      expect(sanitizeSettings({ zoom }).zoom).toBe(100);
    }
    expect(sanitizeSettings({ fontSizePt: "12" }).fontSizePt).toBe(11);
    expect(sanitizeSettings({ fontSizePt: 1000 }).fontSizePt).toBe(96);
  });

  it("does not accept an empty font family or an unknown style", () => {
    expect(sanitizeSettings({ fontFamily: "" }).fontFamily).toBe("Inter");
    expect(sanitizeSettings({ fontStyle: "Wide" }).fontStyle).toBe("Medium");
  });

  it("treats arrays, strings and numbers as no settings at all", () => {
    for (const raw of [[], "x", 5, true, undefined]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it("accepts only real booleans for switches", () => {
    expect(sanitizeSettings({ background: 0, spellcheck: "true", statusBar: false })).toMatchObject({
      background: true,
      spellcheck: false,
      statusBar: false,
    });
  });

  it("sanitizes page setup", () => {
    expect(sanitizePageSetup(null)).toEqual(DEFAULT_PAGE_SETUP);
    expect(sanitizePageSetup({ orientation: "sideways", marginMm: -5, header: 7, footer: "&p" })).toEqual({
      orientation: "portrait",
      marginMm: 0,
      header: "",
      footer: "&p",
    });
    expect(sanitizePageSetup({ orientation: "landscape", marginMm: 400 })).toMatchObject({
      orientation: "landscape",
      marginMm: 100,
    });
  });

  it("sanitizes the recent list", () => {
    expect(sanitizeRecent("C:\\a.md")).toEqual([]);
    expect(sanitizeRecent(["C:\\a.md", "", 5, null, "C:\\b.md"])).toEqual(["C:\\a.md", "C:\\b.md"]);
    expect(sanitizeRecent(Array.from({ length: 30 }, (_v, i) => `C:\\${i}.md`))).toHaveLength(MAX_RECENT);
  });
});

describe("theme and fonts", () => {
  it("follows the system only for the system theme", () => {
    expect(computeDark("system", true)).toBe(true);
    expect(computeDark("system", false)).toBe(false);
    expect(computeDark("light", true)).toBe(false);
    expect(computeDark("dark", false)).toBe(true);
  });

  it("maps style names to CSS weights", () => {
    expect(["Light", "Regular", "Medium", "Semibold", "Bold"].map(fontWeightOf)).toEqual([300, 400, 500, 600, 700]);
    expect(fontWeightOf("Black")).toBe(400);
  });

  it("quotes the family and always falls back to the system UI font", () => {
    expect(fontStack("Noto Nastaliq Urdu")).toBe('"Noto Nastaliq Urdu", "Segoe UI Variable Text", "Segoe UI", sans-serif');
  });

  it("cannot be used to break out of the CSS font-family value", () => {
    const stack = fontStack('Evil", red; x: "\\');
    expect(stack.startsWith('"Evil, red; x: ",')).toBe(true);
    // Only the quotes the stack adds itself: two around each of the three names.
    expect(stack.match(/"/g)).toHaveLength(6);
  });
});

describe("paths: Windows details", () => {
  it("handles roots, bare names and trailing separators", () => {
    expect(dirOf("C:\\a.md")).toBe("C:");
    expect(dirOf("a.md")).toBeNull();
    // A separator in first place leaves no folder name, not an empty one.
    expect(dirOf("\\a.md")).toBeNull();
    expect(fileNameOf("C:\\folder\\")).toBe("");
    expect(fileNameOf("plain.txt")).toBe("plain.txt");
  });

  it("takes only the last extension and treats dotfiles as extensionless", () => {
    expect(extOf("C:\\a\\archive.tar.gz")).toBe(".gz");
    expect(extOf("C:\\v1.2\\notes")).toBe("");
    expect(extOf("C:\\a\\.env")).toBe("");
  });

  it("recognises every markdown extension in any case", () => {
    // BUGS.md M8: .mdx is registered as Markdown by the installer.
    for (const ext of [".md", ".MD", ".markdown", ".mdown", ".mkd", ".mdx"]) expect(isMarkdownPath(`C:\\x${ext}`)).toBe(true);
    for (const ext of [".txt", ".mdtxt", ".m", ""]) expect(isMarkdownPath(`C:\\x${ext}`)).toBe(false);
  });

  it("compares paths with trailing separators, unicode and spaces", () => {
    expect(pathsEqual("C:\\My Notes\\", "c:/my notes")).toBe(true);
    expect(pathsEqual("D:\\اردو\\نوٹ.md", "d:/اردو/نوٹ.md")).toBe(true);
    expect(pathsEqual("C:\\a.md", "C:\\a.md.bak")).toBe(false);
    expect(pathsEqual(null, null)).toBe(false);
  });

  it("resolves relative paths with dot segments, never above the drive", () => {
    expect(resolveRelative("C:\\notes", "./a.md")).toBe("C:\\notes\\a.md");
    expect(resolveRelative("C:\\notes", "../../../../x.md")).toBe("C:\\x.md");
    expect(resolveRelative("C:\\notes", "sub//deep\\x.md")).toBe("C:\\notes\\sub\\deep\\x.md");
  });

  it("resolves against network shares", () => {
    expect(resolveRelative("\\\\server\\share\\docs", "a.md")).toBe("\\\\server\\share\\docs\\a.md");
    expect(resolveRelative("C:\\x", "\\\\server\\share\\b.md")).toBe("\\\\server\\share\\b.md");
  });
});

describe("links: what a document link may open", () => {
  const base = "C:\\notes";

  it("ignores empty links and in-page anchors", () => {
    expect(classifyHref("", base).kind).toBe("none");
    expect(classifyHref("   ", base).kind).toBe("none");
    expect(classifyHref("#section", base).kind).toBe("none");
  });

  it("accepts web links in any case, trimmed", () => {
    expect(classifyHref("  HTTPS://Example.com/x  ", base)).toEqual({ kind: "web", url: "HTTPS://Example.com/x" });
    expect(classifyHref("http://localhost:1420", base).kind).toBe("web");
  });

  it("refuses every other scheme", () => {
    for (const href of ["data:text/html,x", "vbscript:x", "ftp://x", "tauri://x", "file:x.md", "search-ms:query=x"]) {
      expect(classifyHref(href, base).kind, href).toBe("none");
    }
  });

  it("opens absolute and network paths as given", () => {
    expect(classifyHref("D:\\other\\x.md", base)).toEqual({ kind: "file", path: "D:\\other\\x.md" });
    expect(classifyHref("\\\\server\\share\\x.md", base)).toEqual({ kind: "file", path: "\\\\server\\share\\x.md" });
  });

  it("adds .md to extensionless targets and keeps other extensions", () => {
    expect(classifyHref("todo", base)).toEqual({ kind: "file", path: "C:\\notes\\todo.md" });
    expect(classifyHref("todo.txt", base)).toEqual({ kind: "file", path: "C:\\notes\\todo.txt" });
  });

  it("decodes spaces and unicode, and drops the #fragment", () => {
    expect(classifyHref("my%20note.md#part", base)).toEqual({ kind: "file", path: "C:\\notes\\my note.md" });
    expect(classifyHref("%D8%A7%D8%B1%D8%AF%D9%88.md", base)).toEqual({ kind: "file", path: "C:\\notes\\اردو.md" });
  });

  it("uses a malformed percent-encoding as written", () => {
    expect(classifyHref("100%.md", base)).toEqual({ kind: "file", path: "C:\\notes\\100%.md" });
  });

  it("needs a folder for relative links (an untitled tab has none)", () => {
    expect(classifyHref("a.md", null).kind).toBe("none");
    expect(classifyHref("D:\\abs.md", null).kind).toBe("file");
  });

  it("ignores an empty wikilink", () => {
    expect(classifyHref("wikilink:", base).kind).toBe("none");
    expect(classifyHref("wikilink:#heading", base).kind).toBe("none");
  });

  // BUGS.md M7: a dot in a wikilink name is taken as an extension.
  it("M7: [[v1.2 notes]] opens v1.2 notes.md", () => {
    expect(classifyHref("wikilink:v1.2 notes", base)).toEqual({ kind: "file", path: "C:\\notes\\v1.2 notes.md" });
    expect(classifyHref("wikilink:todo.txt", base)).toEqual({ kind: "file", path: "C:\\notes\\todo.txt" });
    expect(classifyHref("wikilink:Plan.md", base)).toEqual({ kind: "file", path: "C:\\notes\\Plan.md" });
    // Wikilinks are plain names: a percent sign is part of the name.
    expect(classifyHref("wikilink:100%25 done", base)).toEqual({ kind: "file", path: "C:\\notes\\100%25 done.md" });
  });

  it("M7: decodes reserved characters such as %23 and %26 in a file name", () => {
    expect(classifyHref("C%23 guide.md", base)).toEqual({ kind: "file", path: "C:\\notes\\C# guide.md" });
    expect(classifyHref("a%26b.md#part", base)).toEqual({ kind: "file", path: "C:\\notes\\a&b.md" });
  });

  it("M7: opens PDFs and images with their default app, not as text", () => {
    expect(classifyHref("report.pdf", base)).toEqual({ kind: "external", path: "C:\\notes\\report.pdf" });
    expect(classifyHref("img/Photo.PNG", base)).toEqual({ kind: "external", path: "C:\\notes\\img\\Photo.PNG" });
    expect(classifyHref("wikilink:scan.pdf", base)).toEqual({ kind: "external", path: "C:\\notes\\scan.pdf" });
    // Programs and scripts are never launched: they open as text.
    expect(classifyHref("setup.exe", base)).toEqual({ kind: "file", path: "C:\\notes\\setup.exe" });
  });

  it("M7: understands file:// links", () => {
    expect(classifyHref("file:///C:/notes/a%20b.md", base)).toEqual({ kind: "file", path: "C:\\notes\\a b.md" });
    expect(classifyHref("file://localhost/D:/x.md#h", base)).toEqual({ kind: "file", path: "D:\\x.md" });
    expect(classifyHref("file://server/share/x.md", base)).toEqual({ kind: "file", path: "\\\\server\\share\\x.md" });
    expect(classifyHref("file:///etc/passwd", base).kind).toBe("none");
  });

  it("M7: a link to a folder opens nothing", () => {
    expect(classifyHref("sub/", base).kind).toBe("none");
    expect(classifyHref("sub\\", base).kind).toBe("none");
  });

  it("M7: a link starting with / is relative to the drive or share root", () => {
    expect(classifyHref("/docs/a.md", base)).toEqual({ kind: "file", path: "C:\\docs\\a.md" });
    expect(classifyHref("/docs/a.md", "\\\\srv\\team\\notes")).toEqual({
      kind: "file",
      path: "\\\\srv\\team\\docs\\a.md",
    });
  });
});

describe("modes, titles and names", () => {
  it("restores formatted mode when a plain tab is saved as markdown", () => {
    expect(modeAfterSave("plain", "x.md", true)).toBe("formatted");
    expect(modeAfterSave("plain", "x.md", false)).toBe("plain");
    expect(modeAfterSave("syntax", "x.txt", true)).toBe("plain");
  });

  it("titles strip markdown markers from both ends, in any script", () => {
    expect(deriveTitle("## سلام دنیا ##")).toBe("سلام دنیا");
    expect(deriveTitle("> **Quote**")).toBe("Quote");
    expect(deriveTitle("1. First")).toBe("1. First");
    expect(deriveTitle("---")).toBe("Untitled");
  });

  it("caps titles at 40 characters without splitting an emoji", () => {
    const title = deriveTitle("😀".repeat(50));
    expect(Array.from(title)).toHaveLength(40);
    expect(title).toBe("😀".repeat(40));
  });

  it("suggests names without characters Windows forbids", () => {
    expect(suggestedFileName({ path: null, title: "a/b\\c|d<e>f", mode: "plain" })).toBe("abcdef.txt");
    expect(suggestedFileName({ path: null, title: "notes. . ", mode: "formatted" })).toBe("notes.md");
    expect(suggestedFileName({ path: null, title: '???""', mode: "formatted" })).toBe("Untitled.md");
    expect(suggestedFileName({ path: null, title: "نوٹس", mode: "formatted" })).toBe("نوٹس.md");
    expect(suggestedFileName({ path: null, title: "tab\there\u0001", mode: "plain" })).toBe("tabhere.txt");
  });

  // BUGS.md T3: Windows reserves device names with any extension.
  it("does not suggest a Windows device name", () => {
    expect(suggestedFileName({ path: null, title: "con", mode: "formatted" })).toBe("con_.md");
    expect(suggestedFileName({ path: null, title: "NUL", mode: "plain" })).toBe("NUL_.txt");
    expect(suggestedFileName({ path: null, title: "com1", mode: "plain" })).toBe("com1_.txt");
    expect(suggestedFileName({ path: null, title: "lpt9.notes", mode: "plain" })).toBe("lpt9_.notes.txt");
    expect(suggestedFileName({ path: null, title: "aux .x", mode: "plain" })).toBe("aux_ .x.txt");
    expect(suggestedFileName({ path: null, title: "console", mode: "plain" })).toBe("console.txt");
    expect(suggestedFileName({ path: null, title: "com10", mode: "plain" })).toBe("com10.txt");
  });

  // BUGS.md C1: the dialog adds the selected filter's extension and checks for
  // overwriting that exact name, so the chosen path is used as it is.
  it("keeps the chosen Save As path without adding an extension", () => {
    expect(chosenSavePath("C:\\x\\LICENSE")).toBe("C:\\x\\LICENSE");
    expect(chosenSavePath("C:\\x\\.gitignore")).toBe("C:\\x\\.gitignore");
    expect(chosenSavePath("C:\\x\\notes.log")).toBe("C:\\x\\notes.log");
  });

  // BUGS.md T4: Windows drops trailing dots and spaces from a file name.
  it("drops trailing dots and spaces from the chosen name, as Windows does", () => {
    expect(chosenSavePath("C:\\x\\notes.")).toBe("C:\\x\\notes");
    expect(chosenSavePath("C:\\x\\notes. . ")).toBe("C:\\x\\notes");
    expect(chosenSavePath("C:\\x.y\\a.md.")).toBe("C:\\x.y\\a.md");
    expect(chosenSavePath("C:\\x\\...")).toBe("C:\\x\\...");
  });

  it("offers the filter matching the mode first", () => {
    expect(saveFilters("plain")[0].extensions).toEqual(["txt"]);
    expect(saveFilters("syntax")[0].extensions).toContain("md");
    expect(saveFilters("formatted").map((f) => f.name)).toEqual(["Markdown", "Text", "All files"]);
  });

  it("formats noon and midnight on the 12-hour clock", () => {
    expect(formatDateTime(new Date(2026, 11, 31, 12, 0), "en-US")).toBe("12:00 PM 12/31/2026");
    expect(formatDateTime(new Date(2026, 0, 1, 23, 59), "en-US")).toBe("11:59 PM 1/1/2026");
  });
});

describe("tab list helpers", () => {
  it("moves a reopened file to the front without changing the original list", () => {
    const list = ["C:\\a.md", "C:\\b.md", "C:\\c.md"];
    expect(pushRecent(list, "C:\\C.MD")).toEqual(["C:\\C.MD", "C:\\a.md", "C:\\b.md"]);
    expect(list).toEqual(["C:\\a.md", "C:\\b.md", "C:\\c.md"]);
  });

  it("ignores impossible moves and clamps the destination", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 5, 0)).toBe(list);
    expect(moveItem(list, -1, 0)).toBe(list);
    expect(moveItem(list, 1, 1)).toBe(list);
    expect(moveItem(list, 0, 99)).toEqual(["b", "c", "a"]);
    expect(moveItem(list, 2, -4)).toEqual(["c", "a", "b"]);
  });

  it("finds no neighbour for an unknown tab", () => {
    expect(neighbourAfterClose(["a", "b"], "z")).toBeNull();
  });

  it("wraps large negative indexes", () => {
    expect(wrapIndex(-7, 3)).toBe(2);
  });
});

describe("file stamps and external changes", () => {
  const stamp = { size: 10, mtimeMs: 1 };
  const other = { size: 10, mtimeMs: 2 };
  const clean = { stamp, dirty: false, externalChange: null };

  it("compares stamps by size and time", () => {
    expect(stampsEqual(stamp, { ...stamp })).toBe(true);
    expect(stampsEqual(stamp, other)).toBe(false);
    expect(stampsEqual(stamp, { size: 11, mtimeMs: 1 })).toBe(false);
    expect(stampsEqual(null, null)).toBe(true);
    expect(stampsEqual(stamp, null)).toBe(false);
  });

  it("handles a partial save that made the text shorter", () => {
    // 1000-byte file, 400 loaded and cut to 100: 600-byte tail.
    expect(loadedOffsetAfterPartialSave(700, 1000, 400)).toBe(100);
    expect(loadedOffsetAfterPartialSave(600, 1000, 400)).toBe(0);
    expect(loadedOffsetAfterPartialSave(500, 1000, 400)).toBeNull();
  });

  it("does nothing for an unchanged file", () => {
    expect(decideExternal(clean, { ...stamp }, null, true)).toBe("none");
  });

  it("clears the bar once disk matches the tab again", () => {
    expect(decideExternal({ ...clean, externalChange: "modified" }, stamp, null, true)).toBe("clear-flag");
    expect(decideExternal(clean, stamp, other, true)).toBe("clear-flag");
  });

  it("does not report a deletion twice, or for a file that was never on disk", () => {
    expect(decideExternal({ ...clean, externalChange: "deleted" }, null, null, true)).toBe("none");
    expect(decideExternal(clean, null, "deleted", true)).toBe("none");
    expect(decideExternal({ ...clean, stamp: null }, null, null, true)).toBe("none");
  });

  it("does not raise the modified bar again while it is showing", () => {
    expect(decideExternal({ stamp, dirty: true, externalChange: "modified" }, other, null, true)).toBe("none");
  });

  it("raises it again for a newer change after Keep mine", () => {
    const newer = { size: 99, mtimeMs: 3 };
    expect(decideExternal({ stamp, dirty: true, externalChange: null }, newer, other, true)).toBe("flag-modified");
  });

  it("just adopts the new stamp of a clean tab that has no editor state", () => {
    expect(decideExternal(clean, other, null, false)).toBe("adopt-stamp");
  });
});

describe("session file", () => {
  const tab = (over: Partial<SessionTab> = {}): SessionTab => ({
    id: "t1",
    path: "C:\\a.md",
    title: "a.md",
    dirty: false,
    mode: "formatted",
    eol: "LF",
    encoding: "utf-8-bom",
    stamp: { size: 5, mtimeMs: 7 },
    loadedOffset: 5,
    fullyLoaded: true,
    hasDraft: false,
    snap: { anchor: 1, head: 2, scrollTop: 30 },
    ...over,
  });

  it("round-trips a session written by the app", () => {
    const file = { v: 1 as const, activeId: "t2", tabs: [tab(), tab({ id: "t2", path: null, title: "Note" })] };
    expect(parseSession(JSON.stringify(file))).toEqual(file);
  });

  it("drops tabs without a usable id, and duplicates", () => {
    const raw = JSON.stringify({ activeId: "t1", tabs: [null, { id: 5 }, { id: "" }, tab(), tab({ title: "dup" })] });
    const parsed = parseSession(raw)!;
    expect(parsed.tabs.map((t) => [t.id, t.title])).toEqual([["t1", "a.md"]]);
  });

  it("repairs invalid fields instead of failing", () => {
    const raw = JSON.stringify({
      activeId: "gone",
      tabs: [{ id: "x", mode: "fancy", eol: "LFCR", encoding: "utf-32", loadedOffset: -50, stamp: { size: "1" }, snap: {} }],
    });
    expect(parseSession(raw)).toEqual({
      v: 1,
      activeId: "x",
      tabs: [
        {
          id: "x",
          path: null,
          title: "Untitled",
          dirty: false,
          mode: "plain",
          eol: "CRLF",
          encoding: "utf-8",
          stamp: null,
          loadedOffset: 0,
          fullyLoaded: false,
          hasDraft: false,
          snap: null,
        },
      ],
    });
  });

  it("returns null when there is no tab list", () => {
    expect(parseSession('{"activeId":"t"}')).toBeNull();
    expect(parseSession("null")).toBeNull();
    expect(parseSession('"text"')).toBeNull();
    expect(parseSession("")).toBeNull();
  });

  it("accepts an empty tab list", () => {
    expect(parseSession('{"tabs":[]}')).toEqual({ v: 1, activeId: "", tabs: [] });
  });

  it("restores a tab as dirty only when its draft was stored", () => {
    expect(tabFromSession(tab({ dirty: true, hasDraft: true })).dirty).toBe(true);
    expect(tabFromSession(tab({ dirty: true, hasDraft: false })).dirty).toBe(false);
  });

  it("restores clean file tabs hibernated and everything else ready", () => {
    expect(tabFromSession(tab()).hibernated).toBe(true);
    expect(tabFromSession(tab({ dirty: true, hasDraft: true })).hibernated).toBe(false);
    expect(tabFromSession(tab({ path: null })).hibernated).toBe(false);
    expect(tabFromSession(tab())).toMatchObject({ externalChange: null, tailChars: null, encoding: "utf-8-bom" });
  });
});

describe("print header and footer codes", () => {
  const ctx = { fileName: "notes.md", date: "11/15/2026", time: "9:00 AM" };

  it("puts plain text in the centre", () => {
    expect(headerFooterBoxes("Draft", ctx)).toEqual({ left: "none", center: '"Draft"', right: "none" });
  });

  it("expands file name, date, time and page number", () => {
    expect(headerFooterBoxes("&f - &d &t", ctx).center).toBe('"notes.md - 11/15/2026 9:00 AM"');
    expect(headerFooterBoxes("Page &p", ctx).center).toBe('"Page " counter(page)');
  });

  it("splits into left, centre and right sections", () => {
    expect(headerFooterBoxes("&l&f&c&d&rPage &p", ctx)).toEqual({
      left: '"notes.md"',
      center: '"11/15/2026"',
      right: '"Page " counter(page)',
    });
  });

  it("accepts upper-case codes, && and unknown codes", () => {
    expect(headerFooterBoxes("&F && &x &", ctx).center).toBe('"notes.md & &x &"');
  });

  it("escapes quotes, backslashes and line breaks so the CSS stays valid", () => {
    const boxes = headerFooterBoxes("&f", { ...ctx, fileName: 'a"b\\c\nd.md' });
    expect(boxes.center).toBe('"a\\"b\\\\c d.md"');
  });

  it("is empty for an empty spec", () => {
    expect(headerFooterBoxes("", ctx)).toEqual({ left: "none", center: "none", right: "none" });
  });
});
