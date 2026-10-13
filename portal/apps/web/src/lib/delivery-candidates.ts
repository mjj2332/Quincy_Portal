import type { CollectionKind, DeliveryCandidateDto, DeliveryItemKind, VideoReviewStatus } from "@quincy/shared";

/**
 * What the Delivery tab offers to publish (#787 slice 10). The list comes from the server (`GET /delivery/candidates`), which applies Publish's own eligibility behind the Client Delivery gate
 * alone; the server's 400 `invalid_selection` stays the authority. This adds only what the tab needs to re-read after a premium write.
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
  /** A Video's Review status; null for everything else and while Video Review is closed (#864). */
  reviewStatus: VideoReviewStatus | null;
};

export const COLLECTION_OF_KIND = { photo: "edited", floorplan: "floorplan", copy: "copy", video: null } as const satisfies Record<DeliveryItemKind, CollectionKind | null>;

export const toDeliveryCandidates = (dtos: readonly DeliveryCandidateDto[]): DeliveryCandidate[] => dtos.map((dto) => ({ ...dto, collection: COLLECTION_OF_KIND[dto.kind] }));
