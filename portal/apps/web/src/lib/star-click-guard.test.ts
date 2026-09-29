import { describe, expect, it } from "vitest";
import {
  STAR_GUARD_RADIUS_PX,
  STAR_GUARD_WINDOW_MS,
  armStarClickGuard,
  guardAfterPointerMove,
  shouldSwallowStarClick,
} from "./star-click-guard";

describe("the star-click guard (#304)", () => {
  const commit = { projectId: "a", x: 100, y: 200, at: 1_000 };

  it("arms only when the move that played carried the committed card, soon after the commit", () => {
    expect(armStarClickGuard(commit, ["b", "a"], 1_050)).toEqual({ projectId: "a", x: 100, y: 200, until: 1_050 + STAR_GUARD_WINDOW_MS });
    // A move elsewhere — another column's refetch — is not this commit's re-sort.
    expect(armStarClickGuard(commit, ["b"], 1_050)).toBeNull();
    expect(armStarClickGuard(commit, ["a"], 3_000)).toBeNull();
    expect(armStarClickGuard(null, ["a"], 1_050)).toBeNull();
  });

  it("swallows a click on a different card's stars at the same spot within the window", () => {
    const guard = armStarClickGuard(commit, ["a"], 1_050);
    expect(shouldSwallowStarClick(guard, { projectId: "b", x: 103, y: 198 }, 1_300)).toBe(true);
  });

  it("lets through the same card, a click beyond the radius, a click after the window, and no guard", () => {
    const guard = armStarClickGuard(commit, ["a"], 1_050);
    expect(shouldSwallowStarClick(guard, { projectId: "a", x: 100, y: 200 }, 1_300)).toBe(false);
    expect(shouldSwallowStarClick(guard, { projectId: "b", x: 100 + STAR_GUARD_RADIUS_PX + 1, y: 200 }, 1_300)).toBe(false);
    expect(shouldSwallowStarClick(guard, { projectId: "b", x: 100, y: 200 }, 1_050 + STAR_GUARD_WINDOW_MS + 1)).toBe(false);
    expect(shouldSwallowStarClick(null, { projectId: "b", x: 100, y: 200 }, 1_300)).toBe(false);
  });

  it("disarms once the pointer moves beyond the radius, and survives jitter inside it", () => {
    const guard = armStarClickGuard(commit, ["a"], 1_050);
    expect(guardAfterPointerMove(guard, { x: 104, y: 203 })).toBe(guard);
    expect(guardAfterPointerMove(guard, { x: 100, y: 200 + STAR_GUARD_RADIUS_PX + 1 })).toBeNull();
    expect(guardAfterPointerMove(null, { x: 0, y: 0 })).toBeNull();
  });
});
