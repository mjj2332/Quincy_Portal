import { describe, expect, it } from "vitest";
import { ROLE_CAPABILITIES, roleHasCapability } from "../src/capabilities";
import { PHOTOGRAPHER_VISIBLE_STAGES, STAGE_KEYS, STAGE_TRANSITIONS } from "../src/stages";

describe("PRD §4 capability matrix", () => {
  it("keeps photographers strictly RAW-only", () => {
    expect(ROLE_CAPABILITIES.photographer).toEqual([
      "uploadRaw",
      "viewRaw",
      "annotateRaw",
      "recommendRaw",
      "compareFrames",
    ]);
    for (const capability of ["viewEdited", "publish", "selectForEditing", "adminBackend"] as const) {
      expect(roleHasCapability("photographer", capability)).toBe(false);
    }
  });

  it("does not give editors user or backend administration", () => {
    expect(roleHasCapability("editor", "manageUsers")).toBe(false);
    expect(roleHasCapability("editor", "adminBackend")).toBe(false);
  });

  it("allows admins and editors, but not photographers, to upload edited images", () => {
    expect(roleHasCapability("admin", "uploadEdited")).toBe(true);
    expect(roleHasCapability("editor", "uploadEdited")).toBe(true);
    expect(roleHasCapability("photographer", "uploadEdited")).toBe(false);
  });

  it("reserves the admin backend for admins", () => {
    expect(roleHasCapability("admin", "adminBackend")).toBe(true);
  });

  it("limits the notice board to admins and editors", () => {
    expect(roleHasCapability("admin", "viewNoticeBoard")).toBe(true);
    expect(roleHasCapability("editor", "viewNoticeBoard")).toBe(true);
    expect(roleHasCapability("photographer", "viewNoticeBoard")).toBe(false);
  });

  it("allows project prioritization only for admins", () => {
    expect(ROLE_CAPABILITIES.admin).toContain("prioritizeProjects");
    expect(ROLE_CAPABILITIES.editor).not.toContain("prioritizeProjects");
    expect(ROLE_CAPABILITIES.photographer).not.toContain("prioritizeProjects");
  });
});

describe("pipeline stage transitions", () => {
  it("limits photographer visibility to the two RAW stages", () => {
    expect(PHOTOGRAPHER_VISIBLE_STAGES).toEqual(["awaiting_raw", "raw_review"]);
  });

  it("forms the shipped linear chain without client_review", () => {
    expect(STAGE_TRANSITIONS).toEqual({
      awaiting_raw: ["raw_review"],
      raw_review: ["editing_autohdr"],
      editing_autohdr: ["edited_review"],
      edited_review: ["delivered"],
      delivered: [],
    });
    expect(STAGE_KEYS).not.toContain("client_review");
    expect("client_review" in STAGE_TRANSITIONS).toBe(false);
  });
});
