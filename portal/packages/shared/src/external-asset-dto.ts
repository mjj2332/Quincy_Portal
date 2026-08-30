import { z } from "zod";

// Leaf module: the external-safe asset DTO, extracted so that `external-upload.ts` and
// `external-project-dto.ts` can both depend on it without importing each other. Previously
// `external-upload.ts` imported `externalAssetSchema` from `external-project-dto.ts` while
// `external-project-dto.ts` imported the upload response schemas back — a cycle whose eager
// `z.object({ asset: externalAssetSchema })` at module init crashed the SPA under `vite serve`
// ("Cannot access 'externalAssetSchema' before initialization"). This file has no shared-package
// imports, so nothing can close the loop through it.

const iso = z.string().min(1);
const uuid = z.string().uuid();

const reviewSchema = z.object({
  stars: z.number().int().min(1).max(5).nullable(),
  colorLabel: z.enum(["select", "maybe", "cut", "hero"]).nullable(),
  decision: z.enum(["approved", "flagged"]).nullable(),
  recommended: z.boolean(),
}).strict();

export const externalAssetSchema = z.object({
  id: uuid,
  collectionId: uuid,
  kind: z.string(),
  originalFilename: z.string(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  ratingFromMetadata: z.number().int().nullable(),
  section: z.string().nullable(),
  renditionStatus: z.enum(["ready", "processing"]),
  createdAt: iso,
  sourceRawAssetId: uuid.nullable(),
  version: z.number().int().positive(),
  versionGroupId: uuid.nullable(),
  supersedesAssetId: uuid.nullable(),
  review: reviewSchema.nullable(),
  selected: z.boolean(),
}).strict();
export type ExternalAssetDto = z.infer<typeof externalAssetSchema>;
