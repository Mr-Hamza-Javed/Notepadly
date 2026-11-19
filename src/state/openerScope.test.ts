// The opener capability lets `openPath` reach any file except programs and scripts
// (BUGS.md 1.6). These tests keep the frontend and that deny list in step: a
// document link to a program or script must never be sent to `openPath`, and must
// still open as text in a tab, as in Windows Notepad.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyHref, EXTERNAL_EXTENSIONS } from "./logic";

interface PathEntry {
  path: string;
}
interface Capability {
  permissions: (string | { identifier: string; allow?: PathEntry[]; deny?: PathEntry[] })[];
}

const capability = JSON.parse(
  readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
) as Capability;

const openPath = capability.permissions.find(
  (p): p is Exclude<Capability["permissions"][number], string> =>
    typeof p !== "string" && p.identifier === "opener:allow-open-path",
);

/** `**\/*.exe` → `.exe`. Every deny entry must have this simple shape. */
const denied = (openPath?.deny ?? []).map(({ path }) => {
  const match = /^\*\*\/\*(\.[a-z0-9-]+)$/.exec(path);
  expect(match, `unexpected deny pattern ${path}`).not.toBeNull();
  return match![1];
});

describe("opener scope: programs and scripts are never launched (BUGS.md 1.6)", () => {
  it("denies the usual program and script types", () => {
    for (const ext of [".exe", ".com", ".scr", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".msi", ".lnk", ".hta", ".url"]) {
      expect(denied, ext).toContain(ext);
    }
  });

  it("does not deny a type the frontend opens with its default app", () => {
    for (const ext of EXTERNAL_EXTENSIONS) expect(denied, ext).not.toContain(ext);
    // Text and Markdown are opened by Notepadly itself, never by the opener.
    for (const ext of [".md", ".txt"]) expect(denied).not.toContain(ext);
  });

  it("never sends a denied type to openPath, however the link is written", () => {
    const base = "C:\\notes";
    for (const ext of denied) {
      const upper = ext.toUpperCase();
      for (const href of [
        `run${ext}`,
        `run${upper}`,
        `./tools/run${ext}#x`,
        `run${ext}?x=1`,
        `C:/Tools/run${ext}`,
        `C:\\Tools\\run${upper}`,
        `file:///C:/Tools/run${ext}`,
        `file://server/share/run${ext}`,
        `\\\\server\\share\\run${ext}`,
        `/run${ext}`,
        `run%20me${ext}`,
        `wikilink:run${ext}`,
      ]) {
        expect(classifyHref(href, base).kind, href).not.toBe("external");
      }
    }
  });

  it("still opens a program or script as text in a tab", () => {
    expect(classifyHref("build.bat", "C:\\notes")).toEqual({ kind: "file", path: "C:\\notes\\build.bat" });
    expect(classifyHref("file:///C:/x/setup.PS1", "C:\\notes")).toEqual({ kind: "file", path: "C:\\x\\setup.PS1" });
    expect(classifyHref("\\\\srv\\s\\app.exe", null)).toEqual({ kind: "file", path: "\\\\srv\\s\\app.exe" });
    for (const ext of denied) {
      expect(classifyHref(`tool${ext}`, "C:\\notes"), ext).toEqual({ kind: "file", path: `C:\\notes\\tool${ext}` });
    }
  });
});
