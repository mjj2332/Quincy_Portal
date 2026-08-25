import type { CollectionKind } from "@quincy/shared";
import { QueryClientContext, useQuery, useQueryClient, type QueryClient, type QueryFunctionContext, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { ApiError, apiGet } from "./api";
import { createActiveProjectDetailsInvalidatedMessage, getProjectQueryRuntime, useProjectQueryRuntime, type ProjectDataResource } from "./project-query-sync";
import type { ReviewPatch, WorkspaceAsset, Review } from "../components/PhotoGrid";
import type { ProjectStageKey } from "./stages";

export type ProjectCollection = { id: string; kind: CollectionKind; status: string; expectedCount: number | null; receivedCount: number };
export type ProjectMember = { id: string; userId: string; roleOnProject: "photographer" | "editor"; name: string; email: string };
export type ProjectDetail = {
  id: string; street: string; suburb: string | null; postcode: string | null; agencyName: string | null; agentName: string | null;
  shootDate: string | null; stageKey: ProjectStageKey; rawFolderPath: string | null; rawFolderLink: string | null;
  coverAssetId: string | null; effectiveCoverAssetId: string | null; collections: ProjectCollection[]; members: ProjectMember[];
};
type AssetsResponse = { assets: WorkspaceAsset[] };

export const projectDataKeys = {
  root: ["project-data"] as const,
  project: (projectId: string) => ["project-data", projectId] as const,
  detail: (projectId: string) => ["project-data", projectId, "detail"] as const,
  assetsRoot: (projectId: string) => ["project-data", projectId, "assets"] as const,
  assets: (projectId: string, collectionKind: CollectionKind) => ["project-data", projectId, "assets", collectionKind] as const,
};

export type AccessErrorScope = "principal" | "project" | "collection";
export type ProjectAccessClassification = { scope: AccessErrorScope; collectionKind?: CollectionKind };

const assetCapabilities: Record<CollectionKind, "viewRaw" | "viewEdited"> = {
  raw: "viewRaw", edited: "viewEdited", video: "viewEdited", floorplan: "viewEdited", copy: "viewEdited",
};

export function isApiError(error: unknown): error is ApiError { return error instanceof ApiError; }
export function isPermanentProjectAccessError(error: unknown): error is ApiError { return isApiError(error) && (error.status === 401 || error.status === 403 || error.status === 404); }

export function classifyProjectAccessError(error: unknown, resource: "detail" | "assets", collectionKind?: CollectionKind): ProjectAccessClassification | null {
  if (!isPermanentProjectAccessError(error)) return null;
  if (error.status === 401) return { scope: "principal" };
  if (resource === "detail" || error.status === 404 || collectionKind === undefined) return { scope: "project" };
  const details = error.details;
  const capability = details && typeof details === "object" ? (details as Record<string, unknown>).capability : undefined;
  return error.status === 403 && capability === assetCapabilities[collectionKind] ? { scope: "collection", collectionKind } : { scope: "project" };
}

export function projectQueryRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) return false;
    if (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500) return failureCount < 2;
    return false;
  }
  return failureCount < 2;
}

function removedDataError(): ApiError {
  return new ApiError("Project data was removed.", 404, { code: "project-data-removed" });
}

function detailPath(projectId: string) { return `/api/projects/${encodeURIComponent(projectId)}`; }
function assetsPath(projectId: string, collectionKind: CollectionKind) { return `${detailPath(projectId)}/assets?collection=${encodeURIComponent(collectionKind)}`; }

export function projectDetailQueryOptions(projectId: string) {
  return {
    queryKey: projectDataKeys.detail(projectId),
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const detail = await apiGet<ProjectDetail>(detailPath(projectId), { signal });
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return detail;
    },
  } as const;
}

export function projectAssetsQueryOptions(projectId: string, collectionKind: CollectionKind) {
  return {
    queryKey: projectDataKeys.assets(projectId, collectionKind),
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const response = await apiGet<AssetsResponse>(assetsPath(projectId, collectionKind), { signal });
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return response.assets;
    },
  } as const;
}

function useOwnedSnapshot() {
  const runtime = useProjectQueryRuntime();
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  return runtime;
}

export function useProjectDetailQuery(projectId: string, enabled: boolean, specialOwnerOwnsKey: boolean): UseQueryResult<ProjectDetail, Error> {
  const queryClient = useQueryClient();
  const runtime = useOwnedSnapshot();
  const key = projectDataKeys.detail(projectId);
  const owned = specialOwnerOwnsKey || runtime.isOwned(key) || isProjectQueryLedgerPending(queryClient, key);
  return useQuery({
    ...projectDetailQueryOptions(projectId), enabled: enabled && !runtime.isProjectRemoved(projectId), staleTime: 15_000,
    refetchInterval: owned ? false : 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: owned ? false : true, refetchOnReconnect: owned ? false : true,
  });
}

export function useProjectAssetsQuery(projectId: string, collectionKind: CollectionKind, enabled: boolean, specialOwnerOwnsKey: boolean): UseQueryResult<WorkspaceAsset[], Error> {
  const queryClient = useQueryClient();
  const runtime = useOwnedSnapshot();
  const key = projectDataKeys.assets(projectId, collectionKind);
  const owned = specialOwnerOwnsKey || runtime.isOwned(key) || isProjectQueryLedgerPending(queryClient, key);
  return useQuery({
    ...projectAssetsQueryOptions(projectId, collectionKind), enabled: enabled && !runtime.isProjectRemoved(projectId), staleTime: 15_000,
    refetchInterval: owned ? false : 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: owned ? false : true, refetchOnReconnect: owned ? false : true,
  });
}

export function usePassiveRawAssetsQuery(projectId: string, enabled: boolean): UseQueryResult<WorkspaceAsset[], Error> {
  const runtime = useOwnedSnapshot();
  return useQuery({
    ...projectAssetsQueryOptions(projectId, "raw"), enabled: enabled && !runtime.isProjectRemoved(projectId), staleTime: Infinity,
    refetchInterval: false, refetchIntervalInBackground: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: false,
  });
}

export type ProjectInvalidation = { projectId: string; resources: ProjectDataResource[] };

export function useOptionalProjectQueryClient(): QueryClient | undefined {
  return useContext(QueryClientContext);
}

export function terminatePrincipalOnUnauthorized(queryClient: QueryClient, error: unknown): void {
  if (isApiError(error) && error.status === 401) void clearPrincipalProjectData(queryClient);
}

export function useProjectAccessTermination(): (error: unknown) => void {
  const queryClient = useOptionalProjectQueryClient();
  return useCallback((error: unknown) => {
    if (queryClient) terminatePrincipalOnUnauthorized(queryClient, error);
  }, [queryClient]);
}

export async function invalidateProjectResources(queryClient: QueryClient, invalidation: ProjectInvalidation, publish = true): Promise<void> {
  const runtime = getProjectQueryRuntime(queryClient);
  const resources = [...new Map(invalidation.resources.map((resource) => [JSON.stringify(resource), resource])).values()];
  const keys = resources.map((resource) => resource.kind === "detail" ? projectDataKeys.detail(invalidation.projectId) : projectDataKeys.assets(invalidation.projectId, resource.collectionKind));
  const queuedResources = resources.filter((_, index) => isProjectQueryLedgerPending(queryClient, keys[index]!));
  const immediateResources = resources.filter((_, index) => !isProjectQueryLedgerPending(queryClient, keys[index]!));
  if (queuedResources.length) queueLedgerInvalidation(queryClient, { ...invalidation, resources: queuedResources }, publish);
  if (!immediateResources.length) return;
  const immediateKeys = immediateResources.map((resource) => resource.kind === "detail" ? projectDataKeys.detail(invalidation.projectId) : projectDataKeys.assets(invalidation.projectId, resource.collectionKind));
  await Promise.all(immediateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" })));
  if (publish) runtime?.publish({ version: 1, type: "project-data-invalidated", projectId: invalidation.projectId, committedAt: new Date().toISOString(), resources: immediateResources });
}

export async function invalidateActiveProjectDetails(queryClient: QueryClient, publish = true): Promise<void> {
  const active = queryClient.getQueryCache().getAll().filter((query) => query.queryKey.length === 3 && query.queryKey[0] === "project-data" && query.queryKey[2] === "detail" && query.getObserversCount() > 0);
  await Promise.all(active.map((query) => queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "active" })));
  if (publish) getProjectQueryRuntime(queryClient)?.publish(createActiveProjectDetailsInvalidatedMessage());
}

export async function purgeProjectData(queryClient: QueryClient, projectId: string): Promise<void> {
  discardAssetLedger(queryClient, projectId);
  const prefix = projectDataKeys.project(projectId);
  await queryClient.cancelQueries({ queryKey: prefix });
  queryClient.removeQueries({ queryKey: prefix });
}

export async function removeProjectData(queryClient: QueryClient, projectId: string): Promise<void> {
  const runtime = getProjectQueryRuntime(queryClient);
  runtime?.markProjectRemoved(projectId);
  runtime?.publish({ version: 1, type: "project-data-removed", projectId, committedAt: new Date().toISOString() });
  await purgeProjectData(queryClient, projectId);
}

export async function clearPrincipalProjectData(queryClient: QueryClient): Promise<void> {
  const runtime = getProjectQueryRuntime(queryClient);
  runtime?.markPrincipalTerminal();
  discardAllAssetLedgers(queryClient);
  await queryClient.cancelQueries();
  queryClient.clear();
}

export type AssetPatch = { selected?: boolean } & ReviewPatch;
type LedgerToken = { id: number; patch: AssetPatch; status: "pending" | "committed"; hasData: boolean };
type CoordinateBase = { assetId: string; field: keyof AssetPatch; value: unknown };
type LedgerState = { nextId: number; tokens: LedgerToken[]; bases: Map<string, CoordinateBase>; queued: ProjectInvalidation | null; queuedPublish: boolean };
const ledgers = new WeakMap<QueryClient, Map<string, LedgerState>>();

function ledgerMap(queryClient: QueryClient) { let map = ledgers.get(queryClient); if (!map) { map = new Map(); ledgers.set(queryClient, map); } return map; }
function ledgerKey(queryKey: QueryKey) { return JSON.stringify(queryKey); }
export function isProjectQueryLedgerPending(queryClient: QueryClient, queryKey: QueryKey) { return (ledgers.get(queryClient)?.get(ledgerKey(queryKey))?.tokens.length ?? 0) > 0; }

function readCoordinate(asset: WorkspaceAsset, field: keyof AssetPatch): unknown {
  if (field === "selected") return asset.selected;
  return (asset.review ?? emptyReview())[field];
}
function writeCoordinate(asset: WorkspaceAsset, field: keyof AssetPatch, value: unknown): WorkspaceAsset {
  if (field === "selected") return { ...asset, selected: Boolean(value) };
  const review = { ...(asset.review ?? emptyReview()), [field]: value } as Review;
  return { ...asset, review };
}
function applyLedgerState(current: WorkspaceAsset[] | undefined, state: LedgerState): WorkspaceAsset[] | undefined {
  if (!current) return undefined;
  let next = current;
  for (const base of state.bases.values()) next = next.map((asset) => asset.id === base.assetId ? writeCoordinate(asset, base.field, base.value) : asset);
  for (const token of state.tokens) {
    for (const field of Object.keys(token.patch) as Array<keyof AssetPatch>) {
      const value = token.patch[field];
      next = next.map((asset) => asset.id === tokenAssetId(token) ? writeCoordinate(asset, field, value) : asset);
    }
  }
  return next;
}
// A token is scoped to one asset. Keeping the id on a non-enumerable-ish helper avoids widening
// the public mutation patch type while retaining a single coordinate ledger per exact key.
const tokenAssets = new WeakMap<object, string>();
function tokenAssetId(token: LedgerToken) { return tokenAssets.get(token) ?? ""; }

export type AssetOptimisticMutation = { commit: () => Promise<void>; fail: () => Promise<void>; tokenId: number };

export async function beginAssetOptimisticMutation(queryClient: QueryClient, projectId: string, collectionKind: CollectionKind, assetId: string, patch: AssetPatch): Promise<AssetOptimisticMutation> {
  const queryKey = projectDataKeys.assets(projectId, collectionKind);
  await queryClient.cancelQueries({ queryKey, exact: true });
  const map = ledgerMap(queryClient); const key = ledgerKey(queryKey); let state = map.get(key);
  if (!state) { state = { nextId: 1, tokens: [], bases: new Map(), queued: null, queuedPublish: false }; map.set(key, state); }
  const current = queryClient.getQueryData<WorkspaceAsset[]>(queryKey);
  const token: LedgerToken = { id: state.nextId++, patch, status: "pending", hasData: current !== undefined };
  tokenAssets.set(token, assetId);
  if (current) for (const field of Object.keys(patch) as Array<keyof AssetPatch>) {
    const asset = current.find((item) => item.id === assetId);
    if (asset && !state.bases.has(`${assetId}:${field}`)) state.bases.set(`${assetId}:${field}`, { assetId, field, value: readCoordinate(asset, field) });
  }
  state.tokens.push(token);
  if (current) queryClient.setQueryData<WorkspaceAsset[]>(queryKey, (latest) => applyLedgerState(latest, state!));
  const settle = async (status: "committed" | "failed") => {
    const active = map.get(key); if (!active || !active.tokens.some((item) => item.id === token.id)) return;
    if (status === "failed") active.tokens = active.tokens.filter((item) => item.id !== token.id); else { const found = active.tokens.find((item) => item.id === token.id); if (found) found.status = "committed"; }
    const pending = active.tokens.some((item) => item.status === "pending");
    if (pending) { queryClient.setQueryData<WorkspaceAsset[]>(queryKey, (latest) => applyLedgerState(latest, active)); return; }
    const committed = active.tokens.some((item) => item.status === "committed");
    queryClient.setQueryData<WorkspaceAsset[]>(queryKey, (latest) => applyLedgerState(latest, active));
    const queued = active.queued; const publish = active.queuedPublish || committed;
    map.delete(key);
    const runtime = getProjectQueryRuntime(queryClient);
    const deferred = runtime?.takeDeferred(queryKey) ?? false;
    if (queued) await invalidateProjectResources(queryClient, queued, publish);
    else if (committed) await invalidateProjectResources(queryClient, { projectId, resources: [{ kind: "assets", collectionKind }] }, true);
    else if (deferred) await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" });
  };
  return { tokenId: token.id, commit: () => settle("committed"), fail: () => settle("failed") };
}

function queueLedgerInvalidation(queryClient: QueryClient, invalidation: ProjectInvalidation, publish: boolean) {
  const map = ledgerMap(queryClient);
  for (const resource of invalidation.resources) {
    const key = resource.kind === "detail" ? projectDataKeys.detail(invalidation.projectId) : projectDataKeys.assets(invalidation.projectId, resource.collectionKind);
    const state = map.get(ledgerKey(key));
    if (!state) continue;
    if (!state.queued) state.queued = { projectId: invalidation.projectId, resources: [] };
    if (!state.queued.resources.some((item) => JSON.stringify(item) === JSON.stringify(resource))) state.queued.resources.push(resource);
    state.queuedPublish ||= publish;
  }
}

function discardAssetLedger(queryClient: QueryClient, projectId: string) {
  const map = ledgers.get(queryClient); if (!map) return;
  for (const key of [...map.keys()]) if (key.includes(JSON.stringify(projectDataKeys.project(projectId)).slice(1, -1))) map.delete(key);
}

export function discardAssetLedgerForResource(queryClient: QueryClient, projectId: string, collectionKind: CollectionKind) {
  ledgers.get(queryClient)?.delete(ledgerKey(projectDataKeys.assets(projectId, collectionKind)));
}

function discardAllAssetLedgers(queryClient: QueryClient) { ledgers.get(queryClient)?.clear(); }

export function emptyReview(): Review { return { stars: null, colorLabel: null, decision: null, recommended: false }; }
