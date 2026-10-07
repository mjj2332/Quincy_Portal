/**
 * RING_IN must survive `cn()` whole (#656 review item 10). twMerge dropped the old bare `focus-visible:!outline`,
 * leaving a width and a colour with no style, which paints nothing wherever a resting `outline-none` sets the style to none.
 */
import { describe, expect, it } from "vitest";
import { RING_IN } from "@/components/AnchoredPopover";
import { cn } from "@/lib/utils";

const tokens = RING_IN.split(/\s+/);

describe("RING_IN survives cn()", () => {
  const callers: Record<string, string[]> = {
    "alone": [RING_IN],
    "after a resting outline-none (reui Item)": ["outline-none focus-visible:ring-0", RING_IN],
    "buttonClasses-style base": ["w-full justify-center", RING_IN],
    "before other utilities": [RING_IN, "min-h-[44px]"],
  };
  for (const [name, parts] of Object.entries(callers)) {
    it(`keeps every token and an explicit solid style: ${name}`, () => {
      const merged = cn(...parts).split(/\s+/);
      for (const token of tokens) expect(merged).toContain(token);
      expect(merged).toContain("focus-visible:!outline-solid");
    });
  }
});
