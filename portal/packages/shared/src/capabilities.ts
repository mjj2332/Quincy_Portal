/**
 * Capability-based authorization (PRD §4, Implementation-Plan §5).
 * Roles are coarse; every permission check in API and UI goes through a capability,
 * so D-06's future role split needs no rewrite of checks.
 */

export const ROLES = ["admin", "photographer", "editor", "external_editor"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  photographer: "Photographer",
  editor: "Editor",
  external_editor: "External editor",
};

export const CAPABILITIES = [
  "viewAllProjects",
  "createProject",
  "editProject",
  "archiveProject",
  "manageUsers",
  "uploadRaw",
  "uploadEdited",
  "viewRaw",
  "annotateRaw",
  "recommendRaw",
  "compareFrames",
  "selectForEditing",
  "viewEdited",
  "reviewEdited",
  "annotateEdited",
  "manageExtras",
  "publish",
  "viewClientPreview",
  "downloadFinal",
  "adminBackend",
  "manageIntegrations",
  "managePipelineConfig",
  "manageDirectory",
  "viewNoticeBoard",
  "collaborateOnProject",
  "prioritizeProjects",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const EXTERNAL_EDITOR_CAPABILITIES = [
  "uploadEdited",
  "viewRaw",
  "annotateRaw",
  "recommendRaw",
  "compareFrames",
  "viewEdited",
  "reviewEdited",
  "annotateEdited",
  "collaborateOnProject",
] as const satisfies readonly Capability[];

/** Foreground ZIP-selection limits shared by the API and its preflight UI. */
export const DOWNLOAD_SELECTION_MAX_ASSETS = 500;
export const DOWNLOAD_SELECTION_MAX_BYTES = 256 * 1024 * 1024;

/**
 * PRD §4 matrix (with contract decisions from Implementation-Plan §3):
 * - RAW upload: Admin + Photographer + Editor (PRD wins over Sitemap).
 * - Photographer: assigned projects only, RAW-only (D-02) — the assigned-project
 *   scoping is enforced separately via project membership, not a capability.
 * - Admin backend (§6.9): Admin only.
 */
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  admin: [
    "viewAllProjects",
    "createProject",
    "editProject",
    "archiveProject",
    "manageUsers",
    "uploadRaw",
    "uploadEdited",
    "viewRaw",
    "annotateRaw",
    "recommendRaw",
    "compareFrames",
    "selectForEditing",
    "viewEdited",
    "reviewEdited",
    "annotateEdited",
    "manageExtras",
    "publish",
    "viewClientPreview",
    "downloadFinal",
    "adminBackend",
    "manageIntegrations",
    "managePipelineConfig",
    "manageDirectory",
    "viewNoticeBoard",
    "collaborateOnProject",
    "prioritizeProjects",
  ],
  editor: [
    "viewAllProjects",
    "uploadRaw",
    "uploadEdited",
    "viewRaw",
    "annotateRaw",
    "recommendRaw",
    "compareFrames",
    "selectForEditing",
    "viewEdited",
    "reviewEdited",
    "annotateEdited",
    "manageExtras",
    "publish",
    "viewClientPreview",
    "downloadFinal",
    "viewNoticeBoard",
    "collaborateOnProject",
  ],
  external_editor: EXTERNAL_EDITOR_CAPABILITIES,
  photographer: [
    "uploadRaw",
    "viewRaw",
    "annotateRaw",
    "recommendRaw",
    "compareFrames",
    "viewNoticeBoard",
    "collaborateOnProject",
  ],
};

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}
