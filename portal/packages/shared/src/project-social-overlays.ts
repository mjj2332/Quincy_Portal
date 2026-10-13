import { z } from "zod";

/**
 * A Project's Social overlays (#870). `available` is the picker's list (never archived), `selected` is every stored join (archived ones included, so an archived overlay stays visible on the
 * Project that had it), and `resolved` is what the Video viewer lays over a Video: the selected non-archived overlays, else the Default, else nothing (an empty library).
 * Neither the R2 key, the byte size nor the Admin audit metadata is exposed: this response is readable by an assigned External editor.
 */
const uuid = z.string().uuid();
export const PROJECT_SOCIAL_OVERLAYS_MAX = 50;

export const projectSocialOverlayChoiceSchema = z.object({
  id: uuid, name: z.string(), platformLabel: z.string(), isDefault: z.boolean(), archivedAt: z.number().int().nullable(),
}).strict();
export type ProjectSocialOverlayChoice = z.infer<typeof projectSocialOverlayChoiceSchema>;

export const projectSocialOverlayPreviewSchema = z.object({
  id: uuid, name: z.string(), platformLabel: z.string(), isDefault: z.boolean(), imageUrl: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
}).strict();
export type ProjectSocialOverlayPreview = z.infer<typeof projectSocialOverlayPreviewSchema>;

export const projectSocialOverlaysResponseSchema = z.object({
  available: z.array(projectSocialOverlayChoiceSchema),
  selected: z.array(projectSocialOverlayChoiceSchema),
  resolved: z.array(projectSocialOverlayPreviewSchema),
  /** A digest of the complete stored join set (archived joins included). PUT echoes it back; a mismatch is 409. Bounded, so the stored set has no ceiling. */
  revision: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ProjectSocialOverlaysResponse = z.infer<typeof projectSocialOverlaysResponseSchema>;

/** `overlayIds` is the selectable set the caller wants. `expectedRevision` is the `revision` it last read. */
export const projectSocialOverlayInput = z.object({
  overlayIds: z.array(uuid).max(PROJECT_SOCIAL_OVERLAYS_MAX).refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate overlay ids" }),
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type ProjectSocialOverlayInput = z.infer<typeof projectSocialOverlayInput>;

/** 409 `social_overlays_conflict`: the stored set moved, and `current` is the fresh read. */
export const projectSocialOverlaysConflictSchema = z.object({ error: z.string(), code: z.literal("social_overlays_conflict"), current: projectSocialOverlaysResponseSchema }).strict();
