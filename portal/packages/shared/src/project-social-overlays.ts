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
}).strict();
export type ProjectSocialOverlaysResponse = z.infer<typeof projectSocialOverlaysResponseSchema>;

/** The stored baseline also holds retained archived joins, so its ceiling is separate from (and above) the limit on what a caller may select. 300 ids stay inside the 16 KiB body cap with the selection. */
export const PROJECT_SOCIAL_OVERLAYS_STORED_MAX = 300;
const idSet = (max: number) => z.array(uuid).max(max).refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate overlay ids" });
/** `overlayIds` is the selectable set the caller wants. `expectedOverlayIds` is the complete stored set it last saw, archived joins included. */
export const projectSocialOverlayInput = z.object({ overlayIds: idSet(PROJECT_SOCIAL_OVERLAYS_MAX), expectedOverlayIds: idSet(PROJECT_SOCIAL_OVERLAYS_STORED_MAX) }).strict();
export type ProjectSocialOverlayInput = z.infer<typeof projectSocialOverlayInput>;

/** 409 `social_overlays_conflict`: the stored set moved, and `current` is the fresh read. */
export const projectSocialOverlaysConflictSchema = z.object({ error: z.string(), code: z.literal("social_overlays_conflict"), current: projectSocialOverlaysResponseSchema }).strict();
