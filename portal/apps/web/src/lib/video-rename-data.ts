import { videoRenameResponseSchema, type VideoDto } from "@quincy/shared";
import { classifyRenameError, type RenameErrorKind } from "./video-rename-errors";
import { writeVideoVersion, type VersionWriteContext, type VersionWriteSpec } from "./video-version-write";

export { classifyRenameError, renameErrorText } from "./video-rename-errors";
export type { ClassifiedRenameError, RenameErrorKind } from "./video-rename-errors";

/**
 * The rename write of the Video card's dialog (#867). Nothing is optimistic: the answer is the fresh Video and goes into the list, then the lists that carry the title are read again. The path names
 * the Version the dialog opened on, so a rename that lost to an upload is refused with the fresh Video, which the cache takes. An External reads the answer through the response-only `video-rename` surface.
 */
export type RenameWriteContext = VersionWriteContext;

/** The film's title is shown by the list, the Review links that name it and the Delivery candidates. */
const RENAME: VersionWriteSpec<RenameErrorKind> = {
  endpoint: "file-name", surface: "video-rename", schema: videoRenameResponseSchema, classify: classifyRenameError,
  freshVideoKinds: ["not_latest"], converge: [{ kind: "videos" }, { kind: "review-links" }, { kind: "delivery-candidates" }, { kind: "delivery" }],
};

export const renameVideoVersion = (ctx: RenameWriteContext, input: { assetId: string; filename: string }): Promise<VideoDto> =>
  writeVideoVersion(ctx, RENAME, input.assetId, { filename: input.filename });
