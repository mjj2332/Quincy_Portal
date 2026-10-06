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
    expect(ruleBody(".rich-text__editor-content .rich-text__link-preview [data-slot=item-description]::selection")).toMatch(/color:\s*var\(--foreground-secondary\)/);
    expect(ruleBody(".rich-text__editor-content .rich-text__link-preview [data-slot=link-preview-meta]::selection")).toMatch(/color:\s*var\(--foreground-secondary\)/);
    expect(card).toContain('data-slot="link-preview-meta"');
    expect(ruleBody(".rich-text__editor-content .ProseMirror-selectednode [data-slot=item]")).toMatch(/border-color:\s*var\(--accent\)/);
    expect(ruleBody(".rich-text__editor-content .ProseMirror-selectednode [data-slot=item]")).not.toMatch(/outline/);
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
    expect(card).toMatch(/actions\s*\?[^\n]*pr-\[var\(--space-6\)\][^\n]*max-\[721px\]:pr-11[^\n]*pointer-coarse:pr-11/);
  });
  it("3c: the desktop padding clears Remove: item px-3 + --space-6 leaves a gap past the 28px button inset --space-2 (#557)", () => {
    expect(card).not.toContain("pr-[var(--space-5)]");
    expect(card).toContain("pr-[var(--space-6)]");
  });
  it("2b: the Download video fallback anchor is excluded from the .rich-text link colour and underline (#556)", () => {
    expect(ruleBody(":is(.rich-text, .rich-text__editor-content) a[data-slot=button]")).toMatch(/color:\s*inherit[\s\S]*text-decoration:\s*none/);
  });
  it("6: the video is a fixed 16/9 box capped at 24rem tall, and its node wrapper shrinks to it so the badge sits on the video (#556)", () => {
    const v = ruleBody(".rich-text__embedded-video");
    expect(v).toMatch(/aspect-ratio:\s*16 \/ 9;/);
    expect(v).not.toMatch(/aspect-ratio:\s*auto/);
    expect(v).toMatch(/width:\s*100%/);
    expect(v).toMatch(/max-width:\s*min\(100%,\s*calc\(24rem \* 16 \/ 9\)\)/);
    expect(ruleBody(".rich-text__embedded-video-node")).toMatch(/width:\s*100%;[^}]*max-width:\s*min\(100%,\s*calc\(24rem \* 16 \/ 9\)\)/);
  });
  it("6c: the --unavailable fallback is a centred grid on the shared box and declares no own aspect-ratio or max-height, so it cannot drift (#592)", () => {
    const u = ruleBody(".rich-text__embedded-video.rich-text__embedded-video--unavailable");
    expect(u).toMatch(/display:\s*grid/); expect(u).toMatch(/place-content:\s*center/);
    expect(u).not.toMatch(/aspect-ratio/); expect(u).not.toMatch(/max-height/);
  });
  it("6d: the fallback panel carries the shared box class, the --unavailable modifier and videoClassName, inside the player's own wrapper (#592)", () => {
    const src = readFileSync(join(here, "../components/quincy/EmbeddedVideo.tsx"), "utf8");
    expect(src).toContain('cn("rich-text__embedded-video rich-text__embedded-video--unavailable", videoClassName)');
    expect(src).toContain('cn("my-[var(--space-2)]", className)');
    expect(src.indexOf("embedded-video--unavailable")).toBeGreaterThan(src.indexOf('cn("my-[var(--space-2)]", className)'));
    const node = readFileSync(join(here, "../components/quincy/EmbeddedVideoEditorNode.tsx"), "utf8");
    expect(node).toContain("rich-text__embedded-video rich-text__embedded-video--unavailable");
  });
  it("6e: a selected composer video node takes the accent border on the shared box class, so the failed preview shows it too, without doubling the wrapper's edge (#592)", () => {
    const sel = ruleBody(".rich-text__editor-content .ProseMirror-selectednode .rich-text__embedded-video-node > .rich-text__embedded-video");
    expect(sel).toMatch(/border-color:\s*var\(--accent\)/);
    expect(readFileSync(join(here, "app.css"), "utf8")).not.toContain("selectednode .rich-text__embedded-video-node > video.rich-text__embedded-video");
    expect(ruleBody(".rich-text__embedded-video-node")).not.toMatch(/border/);
  });
  it("6f: the composer's failed-preview message keeps an explicit ::selection colour, defensive against the #497 trap (global paper-050 text on a light panel), not a reproduced bug (#592)", () => {
    const sel = ruleBody(".rich-text__editor-content .rich-text__embedded-video--unavailable ::selection");
    expect(sel).toMatch(/background:\s*transparent/); expect(sel).toMatch(/color:\s*var\(--foreground-secondary\)/);
  });
  it("6b: the whiteboard dialog player keeps its full width: no 682px cap, no fixed 16/9 box (#556)", () => {
    const dialog = readFileSync(join(here, "../components/quincy/EmbeddedVideoDialog.tsx"), "utf8");
    expect(dialog).toContain("!max-w-none"); expect(dialog).toContain("!aspect-auto");
  });
  it("3b: Remove is inset --space-2 from the card edge so its focus ring clears the border (#557)", () => {
    expect(node).toContain("top-[var(--space-2)] right-[var(--space-2)]");
    expect(node).not.toContain("top-[var(--space-1)]");
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
