import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import {
  assetPremiumResponseSchema, deliveryPageDtoSchema, deliveryPublishResponseSchema, deliveryStateSchema,
  type AssetPremiumResponse, type CollectionKind, type DeliveryPageDto, type DeliveryPublishResponse, type DeliveryState,
} from "@quincy/shared";
import { ZodError } from "zod";
import { ApiError, apiGet, apiPost, apiPut } from "./api";
import { getProjectQueryRuntime } from "./project-query-sync";
import { invalidateProjectSurfaces, projectDataKeys, projectQueryRetry, removedDataError } from "./project-data";
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

const settle = (queryClient: QueryClient, projectId: string, collectionKind?: CollectionKind) =>
  invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "delivery" }, ...(collectionKind ? [{ kind: "assets", collectionKind } as const] : [])], dashboard: false, calendar: false, gantt: false });

/** Puts a state the server just answered into the cache, so the page does not wait on a re-read to show it. */
const putState = (queryClient: QueryClient, projectId: string, state: DeliveryState) => queryClient.setQueryData<DeliveryState | null>(projectDataKeys.delivery(projectId), state);

export async function previewDelivery(projectId: string, input: { assetIds: string[]; coverAssetId: string | null }): Promise<DeliveryPageDto> {
  return z.object({ dto: deliveryPageDtoSchema }).parse(await apiPost<unknown, typeof input>(`${deliveryPath(projectId)}/preview`, input)).dto;
}

export type PublishInput = { assetIds: string[]; coverAssetId: string | null; expectedLatestSet: number | null; operationId: string };
/** Publishes. The answer is the CURRENT page state (also for a replay); it goes into the cache before anything is re-read. */
export async function publishDelivery(queryClient: QueryClient, projectId: string, input: PublishInput): Promise<DeliveryPublishResponse> {
  const response = deliveryPublishResponseSchema.parse(await apiPost<unknown, PublishInput>(`${deliveryPath(projectId)}/publish`, input));
  const { replayed: _replayed, operationSetNumber: _operationSetNumber, ...state } = response;
  putState(queryClient, projectId, state);
  void settle(queryClient, projectId);
  return response;
}

export async function setDeliveryPageEnabled(queryClient: QueryClient, projectId: string, enabled: boolean): Promise<DeliveryState> {
  const state = deliveryStateSchema.parse(await apiPut<unknown, { enabled: boolean }>(`${deliveryPath(projectId)}/page`, { enabled }));
  putState(queryClient, projectId, state);
  return state;
}

/** Photo and document premium: mark or unmark. The Assets list is re-read for the new state. */
export async function setAssetPremium(queryClient: QueryClient, projectId: string, assetId: string, collectionKind: CollectionKind, premium: boolean): Promise<AssetPremiumResponse> {
  try { return assetPremiumResponseSchema.parse(await apiPut<unknown, { premium: boolean }>(`${assetPath(projectId, assetId)}/delivery-premium`, { premium })); }
  finally { void settle(queryClient, projectId, collectionKind); }
}
export async function setAssetPremiumUnlock(queryClient: QueryClient, projectId: string, assetId: string, collectionKind: CollectionKind, input: { unlocked: boolean; paymentRef?: string }): Promise<AssetPremiumResponse> {
  try { return assetPremiumResponseSchema.parse(await apiPut<unknown, typeof input>(`${assetPath(projectId, assetId)}/delivery-premium-unlock`, input)); }
  finally { void settle(queryClient, projectId, collectionKind); }
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
