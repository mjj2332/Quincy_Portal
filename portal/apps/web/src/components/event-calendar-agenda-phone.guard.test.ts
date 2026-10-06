/**
 * Guard (#648): the vendored agenda row's time span stacks above the title on phones. The span was
 * a fixed `w-40 shrink-0` (160px), leaving a 320px viewport's title ~64px. Pins the phone classes
 * and the Quincy edit-log entry that records them, so a re-vendor replays the edit.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const file = readFileSync(new URL("./reui/event-calendar/event-calendar-event.tsx", import.meta.url), "utf8");

describe("event-calendar agenda time span on phones (#648)", () => {
  it("the agenda time span carries the phone-stacking classes", () => {
    const span = file.match(/<span className="([^"]*w-40 shrink-0[^"]*)">\s*\{agendaTimeText\}/);
    expect(span, "agenda time span not found").not.toBeNull();
    const tokens = span?.[1]?.split(/\s+/) ?? [];
    for (const token of ["max-[721px]:w-auto", "max-[721px]:basis-full", "max-[721px]:text-xs"]) {
      expect(tokens).toContain(token);
    }
  });

  it("the Quincy edit log records the change", () => {
    const header = file.slice(0, file.indexOf("*/"));
    expect(header).toMatch(/#648[\s\S]*agenda time span/);
  });
});
