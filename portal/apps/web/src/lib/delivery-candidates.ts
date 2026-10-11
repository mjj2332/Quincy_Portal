import type { CollectionKind, DeliveryItemKind, VideoDto } from "@quincy/shared";
import type { WorkspaceAsset } from "../components/PhotoGrid";

/**
 * What the Delivery tab offers to publish (#787 slice 10), composed client-side from the lists the Project already reads: current Edited photos, the Floorplan and Copy PDFs, and one row per
 * Video at its current Version. It mirrors Publish's eligibility (never RAW, never a Floorplan preview); the server's 400 `invalid_selection` stays the authority. Page order is photos, Floorplans,
 * Copy documents, then Videos, each in the order its list came.
 */
export type DeliveryCandidate = {
  /** The Asset id Publish takes: for a Video, its current Version. */
  assetId: string;
  kind: DeliveryItemKind;
  name: string;
  /** The Collection the Asset lives in, for re-reading it after a premium write; null for a Video, which has its own routes. */
  collection: CollectionKind | null;
  videoId: string | null;
  premium: boolean;
  premiumUnlocked: boolean;
};

export function buildDeliveryCandidates(input: { edited: readonly WorkspaceAsset[]; floorplan: readonly WorkspaceAsset[]; copy: readonly WorkspaceAsset[]; videos: readonly VideoDto[] }): DeliveryCandidate[] {
  const ofAsset = (asset: WorkspaceAsset, kind: DeliveryItemKind, collection: CollectionKind): DeliveryCandidate =>
    ({ assetId: asset.id, kind, name: asset.originalFilename, collection, videoId: null, premium: asset.premium === true, premiumUnlocked: asset.premiumUnlocked === true });
  return [
    ...input.edited.filter((asset) => asset.kind === "photo").map((asset) => ofAsset(asset, "photo", "edited")),
    ...input.floorplan.filter((asset) => asset.kind === "floorplan_pdf").map((asset) => ofAsset(asset, "floorplan", "floorplan")),
    ...input.copy.filter((asset) => asset.kind === "copy_pdf").map((asset) => ofAsset(asset, "copy", "copy")),
    ...input.videos.map((video): DeliveryCandidate => ({ assetId: video.currentAssetId, kind: "video", name: video.title, collection: null, videoId: video.id, premium: video.premium, premiumUnlocked: video.premiumUnlocked })),
  ];
}
