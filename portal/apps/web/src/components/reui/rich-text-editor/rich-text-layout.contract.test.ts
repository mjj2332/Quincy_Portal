import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** Class/option contracts for the #492 design-review fixes (happy-dom has no layout to measure). */
describe("rich-text editor layout contracts", () => {
  it("opens the table bar below the caret so it never covers the main toolbar", () => {
    const source = read("rich-text-table.tsx");
    expect(source).toContain('placement: "bottom-start"');
    expect(source).not.toContain('"top-start"');
  });

  it("outline rows read as menu items: sentence case, no tracking, --text-sm", () => {
    const source = read("rich-text-outline.tsx");
    expect(source).toContain("normal-case");
    expect(source).toContain("tracking-normal");
    expect(source).toContain("text-[length:var(--text-sm)]");
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
