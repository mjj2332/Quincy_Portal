/**
 * #219 PR A fix (dr2-219a LOW #6) — the zoom control's minus glyph reads fainter than its plus.
 *
 * The design reviewer measured the darkest pixel of each 44px zoom button's icon: 166 for `+`,
 * 191 for `-` (lower is darker/more ink) — a visible weight mismatch in an otherwise identical
 * pair sitting one above the other in the same floating control.
 *
 * Root cause, read from the actual lucide-react icon geometry this file imports (`node_modules/
 * lucide-react`, `Plus`/`Minus`), not guessed: `Minus` is a single path, `M5 12h14` — one
 * horizontal line through the exact center of the 24x24 viewBox. `Plus` is that SAME path plus a
 * second, `M12 5v14` — the identical horizontal line, PLUS a vertical one, crossing it at dead
 * center. At `size-3` (12px, half the 24 viewBox), that center lands exactly on a whole-pixel
 * boundary, so each 1px-wide stroke straddles two device pixel rows/columns and anti-aliases to
 * partial coverage on each — identical for both icons' horizontal stroke. `Plus`'s vertical stroke
 * ADDS a second, independent partial-coverage layer at that same center point (source-over
 * compositing: two ~50%-coverage strokes crossing composite to a visibly darker point than
 * either alone), giving `+` one reinforced dark pixel `Minus` structurally cannot have — it has no
 * second stroke to cross with. This is not a difference in DESIGN INTENT between the two icons
 * (same size, same default `strokeWidth`, same colour token) — it is this specific sub-pixel
 * geometry artefact, and it is real (traced directly from lucide's own icon-node source, not
 * eyeballed, and not a browser measurement I have no way to take from this environment — see
 * `gantt-bar-completed-hue.dom.test.tsx`'s header for the same caveat in an earlier fix).
 *
 * Fix: `MinusIcon` alone gets an explicit `strokeWidth={2.5}` (up from lucide's default `2`,
 * `PlusIcon` unchanged) — a modest, deliberate compensation for the crossing-point reinforcement
 * `+` gets "for free" and `-` structurally cannot, bringing the two glyphs' effective ink weight
 * back into parity without changing either icon's footprint, colour, or the 44px tap target
 * around it.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttResource } from "@/components/reui/gantt/gantt-types";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  host.remove();
});

const RESOURCES: GanttResource[] = [{ id: "r1", title: "Row 1" }];
const START = new Date("2026-03-02T00:00:00.000Z");

function findZoomGlyph(label: "Zoom in" | "Zoom out"): SVGSVGElement {
  const button = [...host.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)][0];
  if (!button) throw new Error(`no button found for aria-label "${label}"`);
  const svg = button.querySelector("svg");
  if (!svg) throw new Error(`no svg glyph found inside the "${label}" button`);
  return svg as SVGSVGElement;
}

describe("the zoom control's minus glyph is compensated for lacking a plus glyph's crossing-point reinforcement (#219 PR A, dr2-219a LOW #6)", () => {
  it("the minus icon's stroke-width is explicitly heavier than the plus icon's", async () => {
    await render(
      <Gantt resources={RESOURCES} events={[]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const plusGlyph = findZoomGlyph("Zoom in");
    const minusGlyph = findZoomGlyph("Zoom out");

    const plusStrokeWidth = Number(plusGlyph.getAttribute("stroke-width"));
    const minusStrokeWidth = Number(minusGlyph.getAttribute("stroke-width"));

    expect(Number.isNaN(plusStrokeWidth)).toBe(false);
    expect(Number.isNaN(minusStrokeWidth)).toBe(false);
    expect(minusStrokeWidth).toBeGreaterThan(plusStrokeWidth);
  });
});
