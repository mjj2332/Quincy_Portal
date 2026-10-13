import { describe, expect, it } from "vitest";
import { projectSocialOverlayInput, projectSocialOverlaysResponseSchema } from "../src/project-social-overlays";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const choice = { id: A, name: "Reel", platformLabel: "Instagram", isDefault: true, archivedAt: null };
const preview = { id: A, name: "Reel", platformLabel: "Instagram", isDefault: true, imageUrl: `/social-overlay-images/${A}/${B}`, width: 1080, height: 1920 };

describe("Project Social overlay contract (#870)", () => {
  const REV = "a".repeat(64);
  it("accepts a selection with the revision the caller last saw, including an empty selection", () => {
    expect(projectSocialOverlayInput.parse({ overlayIds: [A, B], expectedRevision: REV })).toEqual({ overlayIds: [A, B], expectedRevision: REV });
    expect(projectSocialOverlayInput.safeParse({ overlayIds: [], expectedRevision: REV }).success).toBe(true);
  });

  it("rejects duplicates, non-UUIDs, a missing or malformed revision, the old expected set and unknown keys", () => {
    for (const bad of [
      { overlayIds: [A, A], expectedRevision: REV }, { overlayIds: ["x"], expectedRevision: REV }, { overlayIds: [A] },
      { overlayIds: [], expectedRevision: "" }, { overlayIds: [], expectedRevision: "z".repeat(65) }, { overlayIds: [], expectedOverlayIds: [] }, { overlayIds: [], expectedRevision: REV, extra: 1 },
    ]) expect(projectSocialOverlayInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("limits the selection to 50 and puts no ceiling on the stored set the revision covers", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(projectSocialOverlayInput.safeParse({ overlayIds: many(50), expectedRevision: REV }).success).toBe(true);
    expect(projectSocialOverlayInput.safeParse({ overlayIds: many(51), expectedRevision: REV }).success).toBe(false);
    const stored = many(400).map((id) => ({ ...choice, id }));
    expect(projectSocialOverlaysResponseSchema.safeParse({ available: [], selected: stored, resolved: [], revision: REV }).success).toBe(true);
  });

  it("is strict about the response and carries no R2 key, bytes or Admin metadata", () => {
    expect(projectSocialOverlaysResponseSchema.parse({ available: [choice], selected: [choice], resolved: [preview], revision: REV }).resolved[0]!.imageUrl).toContain(A);
    expect(projectSocialOverlaysResponseSchema.safeParse({ available: [{ ...choice, bytes: 1 }], selected: [], resolved: [], revision: REV }).success).toBe(false);
    expect(projectSocialOverlaysResponseSchema.safeParse({ available: [], selected: [], resolved: [{ ...preview, imageKey: "k" }], revision: REV }).success).toBe(false);
  });
});
