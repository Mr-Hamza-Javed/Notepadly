// Stylesheet rules that only a real browser applies, checked as text.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** The bodies of every `@media (forced-colors: active)` block in a stylesheet. */
function forcedColorBlocks(text: string): string {
  const blocks: string[] = [];
  const re = /@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    let depth = 1;
    let at = match.index + match[0].length;
    const start = at;
    while (depth > 0 && at < text.length) {
      if (text[at] === "{") depth++;
      else if (text[at] === "}") depth--;
      at++;
    }
    blocks.push(text.slice(start, at - 1));
  }
  return blocks.join("\n");
}

/** The declarations of every rule in `block` whose selector list includes `selector`. */
function rule(block: string, selector: string): string {
  const found: string[] = [];
  for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").trim());
    if (selectors.includes(selector)) found.push(match[2]);
  }
  return found.join(";");
}

// BUGS.md UI-10: in a Windows contrast theme the unsaved dot, the active tab, the
// toggles and radio marks, the menu's hot item and the Find highlights disappeared.
describe("Windows contrast themes (forced colours)", () => {
  const app = forcedColorBlocks(css("app.css"));
  const settings = forcedColorBlocks(css("settings.css"));

  it("keeps the unsaved dot visible", () => {
    const dot = rule(app, ".tab-close .dot");
    expect(dot).toMatch(/forced-color-adjust:\s*none/);
    expect(dot).toMatch(/background:\s*CanvasText/);
  });

  it("marks the active tab and the menu's hot item with Highlight", () => {
    expect(rule(app, '.tab[data-active="true"]')).toMatch(/(outline|border)[^;]*Highlight/);
    expect(rule(app, ".menu-item.hot")).toMatch(/Highlight/);
  });

  it("keeps Find highlights visible", () => {
    expect(rule(app, ".notepadly-cm .cm-find-match")).toMatch(/Highlight/);
    expect(rule(app, ".notepadly-cm .cm-find-current")).toMatch(/background:\s*Highlight/);
  });

  it("keeps the toggle knob and the radio mark visible", () => {
    expect(rule(settings, ".toggle-knob")).toMatch(/forced-color-adjust:\s*none/);
    expect(rule(settings, ".toggle-knob")).toMatch(/background:\s*CanvasText/);
    expect(rule(settings, '.toggle[aria-checked="true"] .toggle-knob')).toMatch(/HighlightText/);
    expect(rule(settings, ".radio-mark")).toMatch(/forced-color-adjust:\s*none/);
    expect(rule(settings, '.radio[aria-checked="true"] .radio-mark')).toMatch(/Highlight/);
  });
});
