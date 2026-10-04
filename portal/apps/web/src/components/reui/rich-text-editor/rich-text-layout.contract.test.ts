import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cn } from "@/lib/utils";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** Class/option contracts for the #492 design-review fixes (happy-dom has no layout to measure). */
describe("rich-text editor layout contracts", () => {
  it("opens the table bar below the caret so it never covers the main toolbar", () => {
    const source = read("rich-text-table.tsx");
    expect(source).toContain('placement: "bottom-start"');
    expect(source).not.toContain('"top-start"');
    // Kept inside the editable surface: never on the frame border or the helper line beneath it.
    // Never flips (a flip above the first-block table covers the toolbar); clamps inside the surface instead.
    expect(source).toMatch(/flip: false/);
    expect(source).toMatch(/shift: \{ boundary: editor\.view\.dom[^}]*crossAxis: true/);
  });

  it("outline rows read as menu items: sentence case, no tracking, --text-sm", () => {
    const source = read("rich-text-outline.tsx");
    expect(source).toContain("normal-case");
    expect(source).toContain("tracking-normal");
    expect(source).toContain("[font:var(--weight-regular)_var(--text-sm)");
  });

  it("the merged row class drops the Button base's text-xs font shorthand (twMerge, not a source grep)", () => {
    const base = /\[font:var\(--weight-regular\)_var\(--text-xs\)[^\]]*\]/.exec(read("../button.tsx"))?.[0];
    const row = /\[font:var\(--weight-regular\)_var\(--text-sm\)[^\]]*\]/.exec(read("rich-text-outline.tsx"))?.[0];
    expect(base).toBeDefined();
    expect(row).toBeDefined();
    const merged = cn(`uppercase ${base}`, `normal-case ${row}`);
    expect(merged).not.toContain("var(--text-xs)");
    expect(merged).toContain("var(--text-sm)");
  });

  it("keeps the outline focus ring inside the scroller (no clipping)", () => {
    const source = read("rich-text-outline.tsx");
    expect(source).not.toContain("overflow-y-auto p-0.5");
    expect(source).toContain("focus-visible:outline-offset-[-2px]");
  });

  it("gives the heading trigger a fixed width so its label never shifts the toolbar", () => {
    const source = readFileSync(new URL("../../QuincyRichTextEditor.tsx", import.meta.url), "utf8");
    expect(source).toContain("min-w-[8.5rem]");
    expect(source).not.toContain("min-w-[112px]");
  });
});
