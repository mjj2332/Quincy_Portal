/**
 * #497 design-review defects, as source contracts: happy-dom applies no stylesheet, so these read the CSS and component source.
 * 1 selected card readable, 2 card is not prose-linked, 3 Remove clears the text, 4 image is 64px, 5 square radius.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const card = readFileSync(join(here, "../components/quincy/LinkPreviewCard.tsx"), "utf8");
const node = readFileSync(join(here, "../components/quincy/LinkPreviewEditorNode.tsx"), "utf8");

function ruleBody(selector: string): string | null {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = (match[1] ?? "").trim().replace(/\s+/g, " ");
    // `:is(a, b)` holds a comma, so a list is only split when it has none.
    const parts = list.includes(":is(") ? [list] : list.split(",").map((s) => s.trim());
    if (parts.includes(selector)) return match[2] ?? "";
  }
  return null;
}

describe("link preview card design (#497)", () => {
  it("1: the selection colour does not blank the card text, and the selected node is outlined", () => {
    expect(node).toContain("rich-text__link-preview");
    const sel = ruleBody(".rich-text__editor-content .rich-text__link-preview ::selection");
    expect(sel).toMatch(/background:\s*transparent/);
    // `inherit` in a ::selection takes the PARENT's ::selection colour (the global paper-050), not the element's colour: explicit tokens only.
    expect(sel).not.toMatch(/inherit|currentColor/i);
    expect(sel).toMatch(/color:\s*var\(--text-primary\)/);
    expect(ruleBody(".rich-text__editor-content .rich-text__link-preview [data-slot=item-description]::selection")).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(ruleBody(".rich-text__editor-content .rich-text__link-preview [data-slot=link-preview-meta]::selection")).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(card).toContain('data-slot="link-preview-meta"');
    expect(ruleBody(".rich-text__editor-content .ProseMirror-selectednode [data-slot=item]")).toMatch(/outline:\s*var\(--border-width-hair\) solid var\(--accent\)/);
  });
  it("2: the card keeps text colour, no underline, and normal paragraph rhythm", () => {
    expect(ruleBody(":is(.rich-text, .rich-text__editor-content) a[data-slot=item]")).toMatch(/color:\s*var\(--text-primary\)[\s\S]*text-decoration:\s*none/);
    expect(ruleBody(":is(.rich-text, .rich-text__editor-content) a[data-slot=item]:hover [data-slot=item-title]")).toMatch(/text-decoration:\s*underline/);
    const p = ruleBody(".rich-text [data-slot=item] p");
    expect(p).toMatch(/margin:\s*0/);
    expect(p).toMatch(/white-space:\s*normal/);
  });
  it("3: Remove is 28px on desktop, 44px coarse, and the card reserves room for it", () => {
    expect(node).toContain('size="icon-sm"');
    expect(node).toContain("pointer-coarse:size-11");
    expect(node).not.toContain('size="icon-xs"');
    expect(card).toMatch(/actions\s*&&[^\n]*pr-\[var\(--space-5\)\][^\n]*max-\[721px\]:pr-11|actions\s*\?[^\n]*pr-\[var\(--space-5\)\][^\n]*max-\[721px\]:pr-11/);
  });
  it("4: the image overrides the Item's size=sm 32px, on desktop and phone", () => {
    expect(card).toContain("size-16 group-data-[size=sm]/item:size-16");
    expect(card).toContain("max-[721px]:size-12 max-[721px]:group-data-[size=sm]/item:size-12");
  });
  it("5: the card is square like Portal cards", () => {
    expect(card).toContain("rounded-[var(--radius-xs)]");
    // The image container (ItemMedia, vendored `rounded-sm` 4px) takes the same 2px radius, passed through its className so tailwind-merge lets it win.
    expect(card).toMatch(/<ItemMedia variant="image" className="[^"]*rounded-\[var\(--radius-xs\)\]/);
  });
});
