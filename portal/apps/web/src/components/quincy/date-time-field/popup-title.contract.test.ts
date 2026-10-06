import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #621: the picker title wraps to two lines instead of truncating to one. At 375px the single-line
 * `truncate` cut "Schedule for Second checklist item, 1 Synthetic Test Street" before the street, and the
 * `title` tooltip does nothing on touch. Source-text contract (happy-dom resolves no layout or classes).
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PopupFrame.tsx"), "utf8");
const eyebrow = /<Eyebrow\b[^>]*>/.exec(source)?.[0] ?? "";

describe("PopupFrame title (#621)", () => {
  it("renders the title Eyebrow", () => {
    expect(eyebrow).not.toBe("");
  });

  it("clamps to two lines instead of truncating to one", () => {
    expect(eyebrow).toContain("line-clamp-2");
    expect(eyebrow).not.toMatch(/\btruncate\b/);
  });

  it("keeps the title attribute for the rare 3+ line case", () => {
    expect(eyebrow).toContain("title={label}");
  });

  it("keeps the Eyebrow's type tokens (no font/size/tracking override)", () => {
    expect(eyebrow).not.toMatch(/\b(text-|font-|tracking-|leading-)/);
  });
});
