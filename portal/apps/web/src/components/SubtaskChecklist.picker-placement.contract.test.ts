// #629: the checklist's Schedule picker keeps the same 16px viewport gutter as every other picker.
// Padding alone is not enough: without the shift collision policy, Base UI's default `align: "flip"` leaves the
// narrow popup flush to the left edge. Every shell-aware picker passes both props together.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "SubtaskChecklist.tsx"), "utf8");

describe("SubtaskChecklist schedule picker placement (#629)", () => {
  it("passes the shell-aware shift avoidance and padding to SubtaskScheduleControl", () => {
    const control = source.match(/<SubtaskScheduleControl\b[^\n]*/)?.[0] ?? "";
    expect(control).toContain("popupCollisionPadding={shellAwarePopupPadding}");
    expect(control).toContain("popupCollisionAvoidance={SHELL_AWARE_SHIFT_AVOIDANCE}");
  });
});
