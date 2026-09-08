/**
 * Mutation proof for `eventCardClassName`'s ordering. Compact cards carry `border-border` from
 * `EVENT_CARD_COMPACT`, which tailwind-merge treats as conflicting with `border-l-signal-*` (both
 * are border-color utilities — the fact that one is side-specific doesn't stop tailwind-merge from
 * grouping them). Whichever class comes LAST in the `cn(...)` call wins; the earlier one is
 * dropped silently, with no error and no failing DOM test, because `border-border` also paints a
 * visible border and nothing else in the suite checks its exact colour.
 *
 * `eventCardClassName` puts `EVENT_CARD_KIND[kind]` last specifically so the kind colour survives
 * on compact cards. This test fails on the pre-fix ordering — `cn("qc-cal-event-card", EVENT_CARD,
 * EVENT_CARD_KIND[kind], compact && EVENT_CARD_COMPACT)` — because in that order the kind colour is
 * the one tailwind-merge drops for `compact: true`. Confirmed by temporarily restoring that
 * ordering locally and re-running this file: the compact-card assertions below failed while the
 * non-compact ones still passed, exactly as this comment predicts.
 */
import { describe, expect, it } from "vitest";
import { eventCardClassName } from "./ProductionCalendarEvent";

const KIND_BORDER: Record<"project_deadline" | "checklist", string> = {
  project_deadline: "border-l-signal-positive",
  checklist: "border-l-signal-info",
};

describe("eventCardClassName", () => {
  const kinds = ["project_deadline", "checklist"] as const;
  const compactValues = [false, true] as const;

  for (const kind of kinds) {
    for (const compact of compactValues) {
      it(`keeps the \`${KIND_BORDER[kind]}\` kind colour for kind=${kind}, compact=${compact}`, () => {
        const className = eventCardClassName(kind, compact);
        expect(className).toContain(KIND_BORDER[kind]);
      });

      it(`keeps the \`qc-cal-event-card\` focus hook for kind=${kind}, compact=${compact}`, () => {
        const className = eventCardClassName(kind, compact);
        expect(className.split(/\s+/)).toContain("qc-cal-event-card");
      });
    }
  }
});
