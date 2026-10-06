/**
 * Time slot focus ring guard (#660, item 2 of #656). A slot's ring must be INWARD: the column's viewport is a masked scroll
 * container, and a mask clips an outline drawn outside it (docs/lessons.md, "A masked scroll viewport's outline never paints").
 * The ring is `RING_IN` alone: it carries `focus-visible:!outline-solid`, which survives `cn()` (the bare `!outline` it once
 * had did not, leaving a width and colour with no style). Source-text guard: happy-dom resolves no cascade.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RING_IN } from "@/components/AnchoredPopover";
import { cn } from "@/lib/utils";
import { openingTag } from "@/testing/source-extract";

const source = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "TimeColumn.tsx"), "utf8");

describe("TimeColumn slot ring is inward and survives twMerge", () => {
  const tag = openingTag(source, "Button", "aria-pressed={isSelected}");

  it("finds the slot button", () => {
    expect(tag).not.toBeNull();
  });
  it("spreads RING_IN and adds no call-site outline patch", () => {
    expect(tag).toContain("RING_IN");
    expect(tag).not.toContain("outline-solid");
  });
  it("keeps every ring token after cn()", () => {
    const merged = cn("w-full justify-center", RING_IN).split(/\s+/);
    for (const token of RING_IN.split(/\s+/)) expect(merged).toContain(token);
  });
  it("gives the column viewport no Tab stop of its own", () => {
    expect(source).toContain("viewportProps={{ tabIndex: -1 }}");
  });
});
