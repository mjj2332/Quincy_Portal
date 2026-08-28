import { describe, expect, it } from "vitest";
import { CAPABILITIES, EXTERNAL_EDITOR_CAPABILITIES, ROLE_CAPABILITIES, ROLE_LABELS, ROLES, roleHasCapability } from "../src/capabilities";
import { PHOTOGRAPHER_VISIBLE_STAGES, STAGE_KEYS, STAGE_TRANSITIONS } from "../src/stages";

describe("PRD §4 capability matrix", () => {
  it("keeps the External Editor role and exact nine-capability allow-list closed", () => {
    expect(ROLES).toEqual(["admin", "photographer", "editor", "external_editor"]);
    expect(ROLE_LABELS.external_editor).toBe("External editor");
    expect(EXTERNAL_EDITOR_CAPABILITIES).toEqual([
      "uploadEdited", "viewRaw", "annotateRaw", "recommendRaw", "compareFrames",
      "viewEdited", "reviewEdited", "annotateEdited", "collaborateOnProject",
    ]);
    expect(ROLE_CAPABILITIES.external_editor).toEqual(EXTERNAL_EDITOR_CAPABILITIES);
    expect(EXTERNAL_EDITOR_CAPABILITIES).toHaveLength(9);
    expect(ROLE_CAPABILITIES.external_editor.every((capability) => CAPABILITIES.includes(capability))).toBe(true);
    expect(roleHasCapability("external_editor", "moveProjectStage" as never)).toBe(false);
    expect(roleHasCapability("external_editor", "viewProductionCalendar" as never)).toBe(false);
  });

  it("keeps the full role/capability boundary explicit", () => {
    const expected = new Set(ROLE_CAPABILITIES.external_editor);
    for (const role of ROLES) {
      for (const capability of CAPABILITIES) expect(roleHasCapability(role, capability)).toBe(role === "external_editor" ? expected.has(capability) : ROLE_CAPABILITIES[role].includes(capability));
    }
  });

  it("fails closed for an unknown persisted global role", () => {
    expect(roleHasCapability("client" as never, "collaborateOnProject")).toBe(false);
  });

  it("keeps photographers strictly RAW-only", () => {
    expect(ROLE_CAPABILITIES.photographer).toEqual([
      "uploadRaw",
      "viewRaw",
      "annotateRaw",
      "recommendRaw",
      "compareFrames",
      "viewNoticeBoard",
      "collaborateOnProject",
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

  it("opens the notice board to all active staff roles", () => {
    expect(roleHasCapability("admin", "viewNoticeBoard")).toBe(true);
    expect(roleHasCapability("editor", "viewNoticeBoard")).toBe(true);
    expect(roleHasCapability("photographer", "viewNoticeBoard")).toBe(true);
  });

  it("offers the collaboration route affordance to every staff role", () => {
    expect(roleHasCapability("admin", "collaborateOnProject")).toBe(true);
    expect(roleHasCapability("editor", "collaborateOnProject")).toBe(true);
    expect(roleHasCapability("photographer", "collaborateOnProject")).toBe(true);
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
