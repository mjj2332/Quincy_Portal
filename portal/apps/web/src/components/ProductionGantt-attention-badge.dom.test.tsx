import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COARSE_TAP_TARGET, GanttRowAttentionBadge } from "./ProductionGantt";
import { CELL_TRIGGER } from "./ProjectDeadlineCell";

/** #693: on a phone the badge is line 2 under the project name and only ~27px wide at 360, so it shows a short label; the accessible name stays the full text. */
const CASES = [
  { reason: "missing_deadline", full: "Deadline not set", short: "Not set", critical: false },
  { reason: "deadline_before_start", full: "Deadline before shoot", short: "Too early", critical: false },
  { reason: "resolution_failed", full: "Schedule could not be resolved", short: "Error", critical: true },
] as const;

function badge(reason: (typeof CASES)[number]["reason"]) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<GanttRowAttentionBadge reason={reason} />);
  return host.querySelector<HTMLElement>(`[data-testid="gantt-row-attention-${reason}"]`)!;
}

describe("GanttRowAttentionBadge short phone labels (#693)", () => {
  for (const { reason, full, short, critical } of CASES) {
    it(`${reason}: full text for assistive tech and desktop, "${short}" on a phone`, () => {
      const el = badge(reason);
      expect(el.getAttribute("title")).toBe(full);
      const [fullSpan, shortSpan] = Array.from(el.children) as [HTMLElement, HTMLElement];
      expect(fullSpan.textContent).toBe(full);
      expect(fullSpan.className).toContain("max-[721px]:sr-only");
      expect(shortSpan.textContent).toBe(short);
      expect(shortSpan.getAttribute("aria-hidden")).toBe("true");
      expect(shortSpan.className).toContain("min-[721px]:hidden");
      expect(el.className).toContain("truncate");
      expect(el.className).toContain("tracking-[0.04em]");
      expect(el.className).toContain("max-[721px]:tracking-[var(--tracking-normal)]");
      expect(el.className.includes("text-signal-critical")).toBe(critical);
    });
  }

  it("the short labels differ in their first word, so truncation never makes two alike", () => {
    expect(new Set(CASES.map((c) => c.short[0])).size).toBe(CASES.length);
  });
});

describe("phone tap targets use the 721 spelling (#692)", () => {
  it("COARSE_TAP_TARGET and CELL_TRIGGER", () => {
    for (const cls of [COARSE_TAP_TARGET, CELL_TRIGGER]) {
      expect(cls).toContain("max-[721px]:min-w-[44px]");
      expect(cls).not.toContain("max-[720px]");
    }
    expect(CELL_TRIGGER).toContain("max-[721px]:min-h-[44px]");
  });
});
