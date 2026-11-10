import { describe, expect, it } from "vitest";
import {
  classifyHref,
  clampZoom,
  decideExternal,
  defaultModeFor,
  deriveTitle,
  dirOf,
  extOf,
  fileNameOf,
  formatDateTime,
  loadedOffsetAfterPartialSave,
  modeAfterSave,
  moveItem,
  neighbourAfterClose,
  parseSession,
  pathsEqual,
  pushRecent,
  resolveRelative,
  sanitizeSettings,
  suggestedFileName,
  wrapIndex,
  DEFAULT_SETTINGS,
  MAX_RECENT,
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
    expect(classifyHref("file:///C:/x", "C:\\n").kind).toBe("none");
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
    expect(formatDateTime(new Date(2026, 10, 10, 0, 5))).toBe("12:05 AM 11/10/2026");
    expect(formatDateTime(new Date(2026, 0, 2, 13, 30))).toBe("1:30 PM 1/2/2026");
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
