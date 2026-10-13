import { describe, expect, it } from "vitest";
import { projectSocialOverlayInput, projectSocialOverlaysResponseSchema } from "../src/project-social-overlays";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const choice = { id: A, name: "Reel", platformLabel: "Instagram", isDefault: true, archivedAt: null };
const preview = { id: A, name: "Reel", platformLabel: "Instagram", isDefault: true, imageUrl: `/social-overlay-images/${A}/${B}`, width: 1080, height: 1920 };

describe("Project Social overlay contract (#870)", () => {
  it("accepts a set and the set the caller last saw, including empty ones", () => {
    expect(projectSocialOverlayInput.parse({ overlayIds: [A, B], expectedOverlayIds: [] })).toEqual({ overlayIds: [A, B], expectedOverlayIds: [] });
    expect(projectSocialOverlayInput.safeParse({ overlayIds: [], expectedOverlayIds: [A] }).success).toBe(true);
  });

  it("rejects duplicates, non-UUIDs, a missing expected set and unknown keys", () => {
    for (const bad of [
      { overlayIds: [A, A], expectedOverlayIds: [] }, { overlayIds: ["x"], expectedOverlayIds: [] }, { overlayIds: [A] },
      { overlayIds: [], expectedOverlayIds: [B, B] }, { overlayIds: [], expectedOverlayIds: [], extra: 1 },
    ]) expect(projectSocialOverlayInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("limits the selection to 50 but accepts a larger stored baseline (retained archived joins)", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(projectSocialOverlayInput.safeParse({ overlayIds: [], expectedOverlayIds: many(51) }).success).toBe(true);
    expect(projectSocialOverlayInput.safeParse({ overlayIds: many(51), expectedOverlayIds: [] }).success).toBe(false);
  });

  it("is strict about the response and carries no R2 key, bytes or Admin metadata", () => {
    expect(projectSocialOverlaysResponseSchema.parse({ available: [choice], selected: [choice], resolved: [preview] }).resolved[0]!.imageUrl).toContain(A);
    expect(projectSocialOverlaysResponseSchema.safeParse({ available: [{ ...choice, bytes: 1 }], selected: [], resolved: [] }).success).toBe(false);
    expect(projectSocialOverlaysResponseSchema.safeParse({ available: [], selected: [], resolved: [{ ...preview, imageKey: "k" }] }).success).toBe(false);
  });
});
