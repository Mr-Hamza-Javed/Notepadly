// @vitest-environment jsdom
import { bootApp, type App } from "../test/appHarness";
import { backend } from "../test/fakeTauri";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { printableMarkdown, sanitizeHtml } from "./print";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/fakeTauri")).tauriMocks.core());
vi.mock("@tauri-apps/api/window", async () => (await import("../test/fakeTauri")).tauriMocks.window());
vi.mock("@tauri-apps/api/webview", async () => (await import("../test/fakeTauri")).tauriMocks.webview());
vi.mock("@tauri-apps/api/webviewWindow", async () => (await import("../test/fakeTauri")).tauriMocks.webviewWindow());
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("../test/fakeTauri")).tauriMocks.dialog());
vi.mock("@tauri-apps/plugin-opener", async () => (await import("../test/fakeTauri")).tauriMocks.opener());

const html = (input: string, baseDir: string | null = "C:\\notes") => {
  const div = document.createElement("div");
  div.appendChild(sanitizeHtml(input, baseDir));
  return div.innerHTML;
};

describe("print sanitising: a document can never run code", () => {
  it("keeps ordinary formatting", () => {
    const input = "<h1>T</h1><p><strong>b</strong> <em>i</em> <del>s</del> <code>c</code></p><ul><li>x</li></ul>";
    expect(html(input)).toBe(input);
  });

  it("drops scripts, styles, frames and SVG together with their content", () => {
    const out = html('<script>alert(1)</script><style>*{}</style><iframe src="x"></iframe><svg><text>s</text></svg>ok');
    expect(out).toBe("ok");
  });

  it("removes event handlers and unknown attributes", () => {
    const out = html('<p onclick="x()" style="color:red" title="t" align="center">p</p>');
    expect(out).toBe('<p title="t" align="center">p</p>');
  });

  it("keeps the text of unknown tags but not the tags", () => {
    expect(html("<marquee>moving <b>bold</b></marquee>")).toBe("moving <b>bold</b>");
  });

  it("allows web and mail links only", () => {
    expect(html('<a href="https://x.y">w</a>')).toBe('<a href="https://x.y">w</a>');
    expect(html('<a href="mailto:a@b.c">m</a>')).toBe('<a href="mailto:a@b.c">m</a>');
    expect(html('<a href="#top">t</a>')).toBe('<a href="#top">t</a>');
    expect(html('<a href="javascript:alert(1)">j</a>')).toBe("<a>j</a>");
    expect(html('<a href="JaVaScRiPt:x">j</a>')).toBe("<a>j</a>");
    expect(html('<a href="file:///C:/x">f</a>')).toBe("<a>f</a>");
  });

  it("only keeps checkbox inputs, for task lists", () => {
    expect(html('<input type="checkbox" checked="" disabled="">')).toBe('<input type="checkbox" checked="" disabled="">');
    expect(html('<input type="text" value="x">')).toBe("");
    expect(html('<input type="image" src="x">')).toBe("");
  });

  it("loads local images through the asset protocol, relative to the document", () => {
    const out = html('<img src="img/a b.png" alt="a">');
    expect(out).toContain(`src="asset://localhost/${encodeURIComponent("C:\\notes\\img\\a b.png")}"`);
    expect(out).toContain('alt="a"');
  });

  it("decodes percent-encoded image paths and accepts absolute drive paths", () => {
    expect(html('<img src="my%20pic.png">')).toContain(encodeURIComponent("C:\\notes\\my pic.png"));
    expect(html('<img src="D:\\pics\\x.png">')).toContain(encodeURIComponent("D:\\pics\\x.png"));
  });

  it("keeps https and data images and drops other schemes", () => {
    expect(html('<img src="https://x.y/a.png">')).toBe('<img src="https://x.y/a.png">');
    expect(html('<img src="data:image/png;base64,AAAA">')).toBe('<img src="data:image/png;base64,AAAA">');
    expect(html('<img src="data:text/html,<b>x</b>">')).toBe("<img>");
    expect(html('<img src="javascript:x">')).toBe("<img>");
  });

  it("drops relative images when the document has no folder", () => {
    expect(html('<img src="a.png">', null)).toBe("<img>");
  });

  it("handles nested dangerous markup", () => {
    const out = html('<div><p><span onmouseover="x"><script>bad()</script>safe</span></p></div>');
    expect(out).toBe("<div><p><span>safe</span></p></div>");
  });
});

describe("what gets printed", () => {
  // Regression for BUGS.md H9 (comments and front matter part).
  it("leaves out front matter and %% comments", () => {
    const text = "---\ntitle: secret\n---\n# Heading\nVisible %%hidden note%% text\n\n%%\nblock comment\n%%\nEnd";
    const out = printableMarkdown(text);
    expect(out).not.toContain("secret");
    expect(out).not.toContain("hidden note");
    expect(out).not.toContain("block comment");
    expect(out).toContain("# Heading");
    expect(out).toContain("Visible  text");
    expect(out).toContain("End");
  });

  it("keeps %% and --- inside code", () => {
    const text = "```\n%% not a comment %%\n---\n```\n\n`%%inline%%`";
    expect(printableMarkdown(text)).toBe(text);
  });

  it("leaves a document without comments unchanged", () => {
    const text = "plain *text*\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    expect(printableMarkdown(text)).toBe(text);
  });
});

describe("printing a tab", () => {
  let app: App;
  const print = vi.fn();

  beforeAll(async () => {
    app = await bootApp();
    window.print = print;
  });

  beforeEach(() => {
    print.mockClear();
    document.getElementById("notepadly-print-root")?.remove();
  });

  it("renders a formatted tab as sanitised HTML and calls print", async () => {
    backend.write("C:\\p\\note.md", "# Title\n\n**bold** %%secret%%\n\n<img src=x onerror=alert(1)>");
    await app.actions.openPaths(["C:\\p\\note.md"]);
    await app.actions.print();
    expect(print).toHaveBeenCalledTimes(1);
    const root = document.getElementById("notepadly-print-root")!;
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.innerHTML).not.toContain("secret");
    expect(root.innerHTML).not.toContain("onerror");
  });

  it("prints plain text exactly, without interpreting markdown or HTML", async () => {
    backend.write("C:\\p\\raw.txt", "# not a heading\n<b>tag</b>");
    await app.actions.openPaths(["C:\\p\\raw.txt"]);
    await app.actions.print();
    const root = document.getElementById("notepadly-print-root")!;
    expect(root.querySelector("pre")?.textContent).toBe("# not a heading\n<b>tag</b>");
    expect(root.querySelector("b")).toBeNull();
  });

  it("puts the page setup into the print stylesheet", async () => {
    app.store.useApp.setState({ pageSetup: { orientation: "landscape", marginMm: 12, header: "&f", footer: "&rPage &p" } });
    backend.write("C:\\p\\head.txt", "x");
    await app.actions.openPaths(["C:\\p\\head.txt"]);
    await app.actions.print();
    const css = document.getElementById("notepadly-print-style")!.textContent!;
    expect(css).toContain("size:landscape");
    expect(css).toContain("margin:12mm");
    expect(css).toContain('@top-center{content:"head.txt"');
    expect(css).toContain('@bottom-right{content:"Page " counter(page)');
  });

  it("reports a file that cannot be loaded instead of printing part of it", async () => {
    const big = "line\n".repeat(120_000);
    backend.write("C:\\p\\big.txt", big);
    await app.actions.openPaths(["C:\\p\\big.txt"]);
    backend.write("C:\\p\\big.txt", "changed by someone else");
    app.engine.insertText("x");
    await app.actions.print();
    expect(print).not.toHaveBeenCalled();
    expect(app.message()?.title).toMatch(/Could not/);
  });
});
