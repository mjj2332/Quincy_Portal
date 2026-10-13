import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import {
  assetPremiumResponseSchema, deliveryCandidatesResponseSchema, deliveryPageDtoSchema, deliveryPublishResponseSchema, deliveryStateSchema, videoPremiumResponseSchema,
  type AssetPremiumResponse, type DeliveryCandidatesResponse, type CollectionKind, type DeliveryPageDto, type DeliveryPublishResponse, type DeliveryState, type VideoDto,
} from "@quincy/shared";
import { ZodError } from "zod";
import { ApiError, apiGet, apiPost, apiPut } from "./api";
import { getProjectQueryRuntime, type ProjectDataResource } from "./project-query-sync";
import { invalidateProjectSurfaces, projectDataKeys, projectQueryRetry, removedDataError, terminatePrincipalOnUnauthorized } from "./project-data";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { onPrincipalTerminal } from "./principal-terminal";
import { classifyVideoApprovalError, videoApprovalErrorText } from "./video-approval-errors";

/**
 * The staff side of Client Delivery (#787 slice 10): the page-state read (whose answer is also whether the Delivery tab exists), Preview, Publish, the Admin page switch and photo/document
 * premium. A closed gate answers 404 and a role without `viewClientPreview` 403; both read as "no Delivery tab" (`null`), never as a Project failure, so they never reach
 * `classifyProjectAccessError`. Nothing is optimistic: every write settles from the server's answer.
 */
const enc = encodeURIComponent;
const deliveryPath = (projectId: string) => `/api/projects/${enc(projectId)}/delivery`;
const assetPath = (projectId: string, assetId: string) => `/api/projects/${enc(projectId)}/assets/${enc(assetId)}`;

/** The page state, or `null` when the Delivery tab is not offered for this Project (gate closed, or not allowed). */
export function useProjectDeliveryQuery(projectId: string, enabled: boolean): UseQueryResult<DeliveryState | null, Error> {
  return useQuery<DeliveryState | null, Error>({
    queryKey: projectDataKeys.delivery(projectId), enabled, staleTime: 15_000, retry: (count, error) => (error instanceof ZodError ? false : projectQueryRetry(count, error)),
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      try {
        const state = deliveryStateSchema.parse(await apiGet<unknown>(deliveryPath(projectId), { signal }));
        if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
        return state;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
    },
  });
}

/** Query clients whose person was signed out (a 401): an answer that lands late must not repopulate or refresh a session that is over (the same guard as `video-approval-data.ts`). */
const retired = new WeakSet<object>();
onPrincipalTerminal((queryClient) => { if (queryClient) retired.add(queryClient); });
/** False once the session is over or the Project has been removed from this one: nothing the server answers after that may be written to its cache. */
const live = (queryClient: QueryClient, projectId: string) => !retired.has(queryClient) && !getProjectQueryRuntime(queryClient)?.isProjectRemoved(projectId);

/** What the tab may offer to publish, or `null` when the tab is not offered. Behind the Client Delivery gate alone, so Video Review being closed does not hide anything (#787 slice 10 round 3). */
export function useDeliveryCandidatesQuery(projectId: string, enabled: boolean): UseQueryResult<DeliveryCandidatesResponse, Error> {
  return useQuery<DeliveryCandidatesResponse, Error>({
    queryKey: projectDataKeys.deliveryCandidates(projectId), enabled, staleTime: 15_000, retry: (count, error) => (error instanceof ZodError ? false : projectQueryRetry(count, error)),
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const response = deliveryCandidatesResponseSchema.parse(await apiGet<unknown>(`${deliveryPath(projectId)}/candidates`, { signal }));
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return response;
    },
  });
}

const settle = (queryClient: QueryClient, projectId: string, extra: ProjectDataResource[] = []) =>
  invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "delivery" }, ...extra], dashboard: false, calendar: false, gantt: false });

/** A Publish can move the Project to Delivered: the same surfaces a stage move settles (Project detail and activity, Dashboard Board, Production Calendar and Gantt), here and in the other tabs. */
const settlePublished = (queryClient: QueryClient, projectId: string) =>
  invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "delivery" }, { kind: "detail" }, { kind: "activity" }, { kind: "review-links" }], dashboard: true, calendar: true, gantt: true });

/**
 * A write that answered with the page state: stop Delivery reads already in flight (they predate it), put the answer into the cache so the page does not wait on a re-read, then
 * invalidate and broadcast the delivery resource. Nothing is written for a session that ended, or a Project that was removed, while the call was in flight.
 */
async function settleState(queryClient: QueryClient, projectId: string, state: DeliveryState, published: boolean): Promise<void> {
  if (!live(queryClient, projectId)) return;
  await queryClient.cancelQueries({ queryKey: projectDataKeys.delivery(projectId), exact: true });
  if (!live(queryClient, projectId)) return;
  queryClient.setQueryData<DeliveryState | null>(projectDataKeys.delivery(projectId), state);
  void (published ? settlePublished(queryClient, projectId) : settle(queryClient, projectId)).catch(() => undefined);
}

/** Whatever a refusal or failure means for the session, whichever call made it: a 401 ends it. */
async function guarded<T>(queryClient: QueryClient, call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (error) { terminatePrincipalOnUnauthorized(queryClient, error); throw error; }
}

export async function previewDelivery(queryClient: QueryClient, projectId: string, input: { assetIds: string[]; coverAssetId: string | null }): Promise<DeliveryPageDto> {
  return guarded(queryClient, async () => z.object({ dto: deliveryPageDtoSchema }).parse(await apiPost<unknown, typeof input>(`${deliveryPath(projectId)}/preview`, input)).dto);
}

export type PublishInput = { assetIds: string[]; coverAssetId: string | null; expectedLatestSet: number | null; operationId: string };
/** Publishes. The answer is the CURRENT page state (also for a replay); it goes into the cache before anything is re-read. */
export async function publishDelivery(queryClient: QueryClient, projectId: string, input: PublishInput): Promise<DeliveryPublishResponse> {
  const response = await guarded(queryClient, async () => deliveryPublishResponseSchema.parse(await apiPost<unknown, PublishInput>(`${deliveryPath(projectId)}/publish`, input)));
  const { replayed: _replayed, operationSetNumber: _operationSetNumber, ...state } = response;
  await settleState(queryClient, projectId, state, true);
  return response;
}

export async function setDeliveryPageEnabled(queryClient: QueryClient, projectId: string, enabled: boolean): Promise<DeliveryState> {
  const state = await guarded(queryClient, async () => deliveryStateSchema.parse(await apiPut<unknown, { enabled: boolean }>(`${deliveryPath(projectId)}/page`, { enabled })));
  await settleState(queryClient, projectId, state, false);
  return state;
}

type PremiumTarget = { assetId: string; collectionKind: CollectionKind } | { videoId: string };
type Flags = { premium: boolean; premiumUnlocked: boolean };

/** Patches one item's premium flags into every cache that shows them (the candidates, the served set, the Assets or Videos list), so the controls show the server's answer before the re-read lands. */
function patchPremium(queryClient: QueryClient, projectId: string, target: PremiumTarget, answer: Flags) {
  if (!live(queryClient, projectId)) return;
  const matches = (item: { assetId: string; videoId: string | null }) => ("videoId" in target ? item.videoId === target.videoId : item.assetId === target.assetId);
  queryClient.setQueryData<DeliveryCandidatesResponse>(projectDataKeys.deliveryCandidates(projectId), (old) => old && { candidates: old.candidates.map((item) => (matches(item) ? { ...item, ...answer } : item)) });
  queryClient.setQueryData<DeliveryState | null>(projectDataKeys.delivery(projectId), (current) => current?.set
    ? { ...current, set: { ...current.set, items: current.set.items.map((item) => (matches(item) ? { ...item, ...answer, locked: answer.premium && !answer.premiumUnlocked } : item)) } }
    : current);
  if ("videoId" in target) queryClient.setQueryData<VideoDto[]>(projectDataKeys.videos(projectId), (list) => list?.map((video) => (video.id === target.videoId ? { ...video, ...answer } : video)));
  else queryClient.setQueryData<WorkspaceAsset[]>(projectDataKeys.assets(projectId, target.collectionKind), (list) => list?.map((asset) => (asset.id === target.assetId ? { ...asset, ...answer } : asset)));
}
/** A premium write: stop reads already in flight (they predate it), patch the caches from the answer, then re-read. */
async function premiumWrite<T extends Flags>(queryClient: QueryClient, projectId: string, target: PremiumTarget, call: () => Promise<T>): Promise<T> {
  const own = "videoId" in target ? projectDataKeys.videos(projectId) : projectDataKeys.assets(projectId, target.collectionKind);
  await Promise.all([own, projectDataKeys.delivery(projectId), projectDataKeys.deliveryCandidates(projectId)].map((queryKey) => queryClient.cancelQueries({ queryKey })));
  try {
    const answer = await guarded(queryClient, call);
    patchPremium(queryClient, projectId, target, answer);
    return answer;
  } finally { if (live(queryClient, projectId)) void settle(queryClient, projectId, [{ kind: "delivery-candidates" }, ...("videoId" in target ? [{ kind: "videos" } as const, { kind: "review-links" } as const] : [{ kind: "assets", collectionKind: target.collectionKind } as const])]); }
}

/** Photo and document premium: mark or unmark. */
export function setAssetPremium(queryClient: QueryClient, projectId: string, assetId: string, collectionKind: CollectionKind, premium: boolean): Promise<AssetPremiumResponse> {
  return premiumWrite(queryClient, projectId, { assetId, collectionKind }, async () => assetPremiumResponseSchema.parse(await apiPut<unknown, { premium: boolean }>(`${assetPath(projectId, assetId)}/delivery-premium`, { premium })));
}
export function setAssetPremiumUnlock(queryClient: QueryClient, projectId: string, assetId: string, collectionKind: CollectionKind, input: { unlocked: boolean; paymentRef?: string }): Promise<AssetPremiumResponse> {
  return premiumWrite(queryClient, projectId, { assetId, collectionKind }, async () => assetPremiumResponseSchema.parse(await apiPut<unknown, typeof input>(`${assetPath(projectId, assetId)}/delivery-premium-unlock`, input)));
}
/** A Video's premium and Unlock, on the Client Delivery routes (the Video Review routes need Video Review open). */
const videoPath = (projectId: string, videoId: string) => `${deliveryPath(projectId)}/videos/${enc(videoId)}`;
export function setDeliveryVideoPremium(queryClient: QueryClient, projectId: string, videoId: string, premium: boolean) {
  return premiumWrite(queryClient, projectId, { videoId }, async () => videoPremiumResponseSchema.parse(await apiPut<unknown, { premium: boolean }>(`${videoPath(projectId, videoId)}/premium`, { premium })));
}
export function setDeliveryVideoPremiumUnlock(queryClient: QueryClient, projectId: string, videoId: string, input: { unlocked: boolean; paymentRef?: string }) {
  return premiumWrite(queryClient, projectId, { videoId }, async () => videoPremiumResponseSchema.parse(await apiPut<unknown, typeof input>(`${videoPath(projectId, videoId)}/premium-unlock`, input)));
}

const detailsOf = (error: unknown): Record<string, unknown> => (error instanceof ApiError && error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {});
export const errorCode = (error: unknown): string | undefined => { const code = detailsOf(error).code; return typeof code === "string" ? code : undefined; };
/** The Assets a 400 `invalid_selection` names. */
export const refusedAssetIds = (error: unknown): string[] => { const ids = detailsOf(error).assetIds; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; };

/**
 * What a refusal says to a person. `named` is the display names of the Assets a 400 `invalid_selection` listed. A transport failure is `network`: Publish carries an operation id, so trying the same selection
 * again is safe and cannot publish twice.
 */
export function deliveryErrorText(error: unknown, named: string[] = []): string {
  const code = errorCode(error);
  if (error instanceof ApiError && error.status === 0) return "Couldn't reach the server. If the Publish went through, trying again does not publish twice.";
  switch (code) {
    case "stale_set": return "The Delivery page changed since you loaded it. It has been reloaded: check your selection, then publish again.";
    case "delivered_stage_unavailable": return "This Project can't be moved to Delivered right now, so it can't be published. Nothing was changed.";
    case "project_archived": return "This project is archived, so publishing and premium are read-only. Restore it to make changes.";
    case "invalid_cover": return "The cover must be one of the selected photos.";
    case "invalid_selection": return named.length ? `Some selected items can't be on a Delivery page, so they were deselected: ${named.join(", ")}.` : "Some selected items can't be on a Delivery page.";
    case "premium_published": return "This item is on a published Delivery page, so it stays premium. Use Unlock or Re-lock instead.";
    case "not_premium_eligible": return "Only a photo, a Floorplan PDF or a Copy document can be a paid extra.";
    case "no_page": return "This Project has no Delivery page yet; the first Publish creates it.";
  }
  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return "You no longer have access to this. It has been refreshed.";
  if (error instanceof ApiError && error.status >= 500) return "Something went wrong on the server. The change may have been applied; check the page before trying again.";
  if (error instanceof ApiError) return "That didn't go through. Try again.";
  return videoApprovalErrorText(classifyVideoApprovalError(error));
}
