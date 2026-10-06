import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cn } from "@/lib/utils";
import { tableBubbleOptions } from "./rich-text-table-position";
import { RICH_TEXT_PHONE_QUERY } from "./rich-text-toolbar";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** Class/option contracts for the #492 design-review fixes (happy-dom has no layout to measure). */
describe("rich-text editor layout contracts", () => {
  it("opens the table bar below the caret so it never covers the main toolbar", () => {
    const source = read("rich-text-table.tsx");
    // The options come from the exported builder (tested in rich-text-table-position.test.ts), not a literal.
    expect(source).toContain("tableBubbleOptions(");
    expect(source).not.toMatch(/boundary: editor\.view\.dom/);
    const options = tableBubbleOptions({
      surface: () => ({ top: 500, left: 20, right: 340, bottom: 640 }),
      row: () => ({ top: 560, left: 20, right: 340, bottom: 600 }),
      viewport: () => ({ top: 0, bottom: 900 }),
    });
    // flip and shift are derivable: they read the bar's real height from floating-ui's state, never a constant.
    const state = { placement: "top-start", rects: { reference: {}, floating: { x: 0, y: 0, width: 280, height: 38 } } } as never;
    expect(options.placement).toBe("top-start");
    // The offset is derivable too: the gap is 8 here, and less in the tight tier (the same gap feeds the padding).
    expect(typeof options.offset).toBe("function");
    expect(options.offset(state)).toBe(8);
    const flipOptions = options.flip(state);
    expect(flipOptions.fallbackPlacements).toEqual(["bottom-start"]);
    // "bestFit", never "initialPlacement": a candidate that overflows is judged by its overflow, not forced.
    expect(flipOptions.fallbackStrategy).toBe("bestFit");
    expect(flipOptions.rootBoundary).toBe("viewport");
    expect(flipOptions.padding).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
    // One boundary for both, rebuilt per pass; its edges equal the final bar's limits (padding and offset are the same gap).
    expect(flipOptions.boundary).toEqual(options.shift(state).boundary);
    expect(flipOptions.boundary.top).toBe(500);
    expect(flipOptions.boundary.bottom).toBe(640); // the frame, not the helper (#555)
    // Horizontal only: a vertical shift would move the bar off its gap, or onto the row.
    expect(options.shift(state).crossAxis).toBe(false);
    expect(options.shift(state).padding).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
    expect(options.shift(state).rootBoundary).toBe("viewport");
  });

  it("the phone path is gated by a JS query that agrees with the Tailwind max-[721px] variant at exactly 721px", () => {
    // Tailwind's max-[721px]: is `@media (width < 721px)`; "(max-width: 721px)" would disagree at exactly 721px.
    expect(RICH_TEXT_PHONE_QUERY).toBe("(width < 721px)");
    expect(read("rich-text-toolbar.tsx")).toContain("max-[721px]:");
    expect(read("rich-text-table.tsx")).toContain("max-[721px]:size-11");
  });

  it("the toolbar's scroll-fade mask applies at every width (the desktop tier-none fallback overflows too); only touch targets are phone-only", () => {
    const source = read("rich-text-toolbar.tsx");
    for (const fade of ["end", "start", "both"]) {
      expect(source).toContain(` data-[fade=${fade}]:[mask-image:`);
      expect(source).not.toContain(`max-[721px]:data-[fade=${fade}]`);
    }
    expect(read("rich-text-table.tsx")).toContain("max-[721px]:size-11");
  });

  it("the floating table bar's surface has no outer padding (the bar is 38px, so it fits above row 2 of a first-block table)", () => {
    const surface = /data-testid=\{testId\}[^>]*?className=\{cn\("([^"]*)"/s.exec(read("rich-text-bubble-bar.tsx"))?.[1];
    expect(surface).toBeDefined();
    expect(surface!.split(/\s+/)).not.toContain("p-1");
  });

  it("mounts the floating table bar only when the phone path is off, and the toolbar group on the phone or when the bar has no room (tier none)", () => {
    const source = readFileSync(new URL("../../QuincyRichTextEditor.tsx", import.meta.url), "utf8");
    expect(source).toContain("useMediaQuery(RICH_TEXT_PHONE_QUERY)");
    expect(source).toMatch(/!phone && <RichTextTableBubble/);
    expect(source).toMatch(/const tableInToolbar = phone \|\| tableTier === "none"/);
    expect(source).toMatch(/tableInToolbar && state\.inTable && <RichTextTableTools/);
  });

  it("the bar stays mounted but inert, hidden from assistive tech and invisible when the toolbar group takes over (tier none), and exposes its tier", () => {
    const bar = read("rich-text-bubble-bar.tsx");
    expect(bar).toMatch(/inert=\{inactive/);
    expect(bar).toMatch(/aria-hidden=\{inactive/);
    expect(bar).toContain("data-tier={tier}");
    expect(bar).toMatch(/inactive && "invisible"/);
    expect(read("rich-text-table.tsx")).toMatch(/inactive=\{tier === "none"\}/);
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
    expect(source).toContain("outline-offset-[-2px] focus-visible:!outline-offset-[-2px]");
  });

  it("gives the heading trigger a fixed width so its label never shifts the toolbar", () => {
    const source = readFileSync(new URL("../../QuincyRichTextEditor.tsx", import.meta.url), "utf8");
    expect(source).toContain("min-w-[8.5rem]");
    expect(source).not.toContain("min-w-[112px]");
  });
});
