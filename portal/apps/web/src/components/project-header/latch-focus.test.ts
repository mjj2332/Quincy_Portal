import { describe, expect, it } from "vitest";
import { latchFocusTarget, type LatchFocusTargets } from "./latch-focus";

// #914 standards review: one map from the refusal's source to the read-only group focus returns to, inside Project info or out.
describe("latchFocusTarget (#455, #914)", () => {
  const el = (name: string) => ({ current: { name } as unknown as HTMLElement });
  const targets: LatchFocusTargets = {
    stage: { info: el("info-stage"), header: el("header-stage") },
    deadline: { info: el("info-deadline"), header: el("header-deadline") },
    dropbox: { info: el("dropbox"), header: el("dropbox") },
    team: { info: null, header: null },
    "social-overlays": { info: el("info-overlays"), header: null },
  };
  const name = (element: HTMLElement | null) => (element as unknown as { name: string } | null)?.name ?? null;

  it("goes to the Project info row while Project info is open, and the header group otherwise", () => {
    expect(name(latchFocusTarget(targets, "stage", true))).toBe("info-stage");
    expect(name(latchFocusTarget(targets, "stage", false))).toBe("header-stage");
    expect(name(latchFocusTarget(targets, "deadline", false))).toBe("header-deadline");
    expect(name(latchFocusTarget(targets, "dropbox", false))).toBe("dropbox");
  });

  it("never sends a Social overlays refusal to the Stage: outside Project info there is nowhere to go", () => {
    expect(name(latchFocusTarget(targets, "social-overlays", true))).toBe("info-overlays");
    expect(latchFocusTarget(targets, "social-overlays", false)).toBeNull();
  });

  it("leaves the Team to move its own focus", () => {
    expect(latchFocusTarget(targets, "team", true)).toBeNull();
    expect(latchFocusTarget(targets, "team", false)).toBeNull();
  });
});
