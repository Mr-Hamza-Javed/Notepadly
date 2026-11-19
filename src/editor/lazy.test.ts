// @vitest-environment jsdom
// Lazily loaded renderers: KaTeX limits and the Mermaid caches (BUGS.md "Review: live preview").
import "../test/dom";
import { describe, expect, it, vi } from "vitest";
import { cachedMermaidError, renderMath, renderMermaid } from "./lazy";
import { MathWidget, MermaidWidget } from "./livePreview/widgets";

const mermaid = vi.hoisted(() => ({
  render: vi.fn(async (_id: string, src: string) => {
    if (src.includes("broken")) throw new Error("Parse error on line 1");
    return { svg: `<svg>${src}</svg>` };
  }),
}));
vi.mock("mermaid", () => ({ default: { initialize: () => undefined, render: mermaid.render } }));

describe("KaTeX limits", () => {
  it("an enormous \\rule is capped at 100em instead of breaking the layout", async () => {
    const { html } = await renderMath("\\rule{99999em}{99999em}", true);
    expect(html).not.toContain("99999");
    expect(html).toMatch(/100em/);
  });
});

describe("Mermaid caches", () => {
  it("a broken diagram is parsed once; its error is cached like a rendered SVG", async () => {
    mermaid.render.mockClear();
    await expect(renderMermaid("graph broken", false)).rejects.toThrow("Parse error on line 1");
    await expect(renderMermaid("graph broken", false)).rejects.toThrow("Parse error on line 1");
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(cachedMermaidError("graph broken", false)).toBe("Parse error on line 1");
    // A working diagram is unaffected.
    expect((await renderMermaid("graph TD; A-->B", false)).html).toBe("<svg>graph TD; A-->B</svg>");
  });
});

describe("widget offsets", () => {
  it("maths and Mermaid widgets with a moved source offset are not equal, so clicks land right", () => {
    expect(new MathWidget("x", true, 2).eq(new MathWidget("x", true, 3))).toBe(false);
    expect(new MathWidget("x", true, 2).eq(new MathWidget("x", true, 2))).toBe(true);
    expect(new MermaidWidget("g", false, 11).eq(new MermaidWidget("g", false, 12))).toBe(false);
    expect(new MermaidWidget("g", false, 11).eq(new MermaidWidget("g", false, 11))).toBe(true);
  });
});
