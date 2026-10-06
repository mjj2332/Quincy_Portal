/**
 * Time slot focus ring guard (#660, item 2 of #656). A slot's ring must be INWARD: the column's viewport is a masked scroll
 * container, and a mask clips an outline drawn outside it (docs/lessons.md, "A masked scroll viewport's outline never paints").
 * The ring is `RING_IN` plus `focus-visible:!outline-solid`: twMerge drops RING_IN's bare `focus-visible:!outline`, so without
 * the explicit style the ring has a width and colour and paints nothing. Source-text guard: happy-dom resolves no cascade.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RING_IN } from "@/components/AnchoredPopover";
import { cn } from "@/lib/utils";
import { openingTag } from "../container-focus.guard.test";

const source = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "TimeColumn.tsx"), "utf8");
const SOLID = "focus-visible:!outline-solid";

describe("TimeColumn slot ring is inward and survives twMerge", () => {
  const tag = openingTag(source, "Button", "aria-pressed={isSelected}");

  it("finds the slot button", () => {
    expect(tag).not.toBeNull();
  });
  it("spreads RING_IN and restores the outline style", () => {
    expect(tag).toContain("RING_IN");
    expect(tag).toContain(SOLID);
  });
  it("keeps every ring token after cn()", () => {
    const merged = cn("w-full justify-center", RING_IN, SOLID).split(/\s+/);
    for (const token of [...RING_IN.split(/\s+/).filter((t) => t !== "focus-visible:!outline"), SOLID]) expect(merged).toContain(token);
  });
  it("gives the column viewport no Tab stop of its own", () => {
    expect(source).toContain("viewportProps={{ tabIndex: -1 }}");
  });
});
