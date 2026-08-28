import { isStageKey, type ChecklistScheduleDto, type CollectionKind, type ProjectDeadlineSchedule, type ProjectMembershipDto, type ProjectMemberRole, type Role } from "@quincy/shared";
import { QueryClient, QueryClientContext, useQuery, useQueryClient, type QueryFunctionContext, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, apiGet } from "./api";
import { externalApiGet, externalProjectDetailToWorkspace } from "./external-api-response";
import type { ExternalProjectDetailDto } from "@quincy/shared";
import { createActiveProjectDetailsInvalidatedMessage, getProjectQueryRuntime, projectResourceKey, useProjectQueryRuntime, type ProjectDataResource } from "./project-query-sync";
import type { ReviewPatch, WorkspaceAsset, Review } from "../components/PhotoGrid";
import type { ProjectStageKey } from "./stages";

export type ProjectCollection = { id: string; kind: CollectionKind; status: string; expectedCount: number | null; receivedCount: number };
export type ProjectMember = ProjectMembershipDto;
export type ProjectDetail = {
  id: string; street: string; suburb: string | null; postcode: string | null; agencyName: string | null; agentName: string | null;
  shootDate: string | null; stageKey: ProjectStageKey; rawFolderPath: string | null; rawFolderLink: string | null; productionNotes?: string | null; editedUploadAvailable?: boolean; boardRevision: number; contractEnabled: boolean;
  coverAssetId: string | null; effectiveCoverAssetId: string | null; collections: ProjectCollection[]; members: ProjectMember[]; deadlineSchedule: ProjectDeadlineSchedule;
};
export type ProjectSubtask = {
  id: string; title: string; done: boolean; position: number;
  assignee: { id: string; name: string } | null; assignmentVersion: number;
  dueDate: string | null; schedule: ChecklistScheduleDto; createdBy: string; createdAt: string; updatedAt: string;
};
type AssetsResponse = { assets: WorkspaceAsset[] };

export const projectDataKeys = {
  root: ["project-data"] as const,
  project: (projectId: string) => ["project-data", projectId] as const,
  detail: (projectId: string) => ["project-data", projectId, "detail"] as const,
  assetsRoot: (projectId: string) => ["project-data", projectId, "assets"] as const,
  assets: (projectId: string, collectionKind: CollectionKind) => ["project-data", projectId, "assets", collectionKind] as const,
  subtasks: (projectId: string) => ["project-data", projectId, "subtasks"] as const,
  commentsRoot: (projectId: string) => ["project-data", projectId, "comments"] as const,
  comments: (projectId: string) => ["project-data", projectId, "comments", "pages", { limit: 50 }] as const,
  commentReadMarker: (projectId: string) => ["project-data", projectId, "comments", "read-marker"] as const,
  collaborationSummary: (projectId: string) => ["project-data", projectId, "collaboration-summary"] as const,
};

export type AccessErrorScope = "principal" | "project" | "collection" | "collaboration";
export type ProjectAccessClassification = { scope: AccessErrorScope; collectionKind?: CollectionKind };

const assetCapabilities: Record<CollectionKind, "viewRaw" | "viewEdited"> = {
  raw: "viewRaw", edited: "viewEdited", video: "viewEdited", floorplan: "viewEdited", copy: "viewEdited",
};

export function isApiError(error: unknown): error is ApiError { return error instanceof ApiError; }
export function isPermanentProjectAccessError(error: unknown): error is ApiError { return isApiError(error) && (error.status === 401 || error.status === 403 || error.status === 404); }

export function classifyProjectAccessError(error: unknown, resource: "detail" | "assets" | "subtasks" | "comments" | "comment-read-marker" | "collaboration-summary", collectionKind?: CollectionKind): ProjectAccessClassification | null {
  if (!isPermanentProjectAccessError(error)) return null;
  if (error.status === 401) return { scope: "principal" };
  if (resource === "comments" || resource === "comment-read-marker" || resource === "collaboration-summary" || resource === "subtasks") return error.status === 403 ? { scope: "collaboration" } : { scope: "project" };
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

export function removedDataError(): ApiError {
  return new ApiError("Project data was removed.", 404, { code: "project-data-removed" });
}

function detailPath(projectId: string) { return `/api/projects/${encodeURIComponent(projectId)}`; }
function assetsPath(projectId: string, collectionKind: CollectionKind) { return `${detailPath(projectId)}/assets?collection=${encodeURIComponent(collectionKind)}`; }
function collaborationSummaryPath(projectId: string) { return `/api/projects/${encodeURIComponent(projectId)}/collaboration-summary`; }
function subtasksPath(projectId: string) { return `/api/projects/${encodeURIComponent(projectId)}/subtasks`; }

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

export function projectCollaborationSummaryQueryOptions(projectId: string) {
  return {
    queryKey: projectDataKeys.collaborationSummary(projectId),
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const generation = projectCollaborationDataGeneration(client, projectId);
      const summary = await apiGet<ProjectCollaborationSummary>(collaborationSummaryPath(projectId), { signal });
      if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      if (projectCollaborationDataGeneration(client, projectId) !== generation) throw new DOMException("The operation was aborted.", "AbortError");
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      if (!isProjectCollaborationSummary(summary, projectId)) throw new Error("Invalid collaboration summary response");
      return summary;
    },
  } as const;
}

type ProjectSubtasksResponse = { subtasks?: ProjectSubtask[] };

export function projectSubtasksQueryOptions(projectId: string) {
  return {
    queryKey: projectDataKeys.subtasks(projectId),
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const generation = projectCollaborationDataGeneration(client, projectId);
      const response = await apiGet<ProjectSubtasksResponse>(subtasksPath(projectId), { signal });
      if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      if (projectCollaborationDataGeneration(client, projectId) !== generation) throw new DOMException("The operation was aborted.", "AbortError");
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return (response.subtasks ?? []).slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    },
  } as const;
}

export function projectAssignmentCandidatesQueryOptions() {
  return {
    queryKey: ["project-assignment-candidates"] as const,
    queryFn: () => apiGet<ProjectAssignmentCandidates>("/api/project-assignment-candidates"),
  } as const;
}

export function useProjectAssignmentCandidatesQuery(enabled: boolean) {
  return useQuery({
    ...projectAssignmentCandidatesQueryOptions(), enabled, staleTime: 15_000, refetchInterval: enabled ? 30_000 : false,
    refetchIntervalInBackground: false, refetchOnWindowFocus: true, refetchOnReconnect: true, retry: projectQueryRetry,
  });
}

export function useOwnedSnapshot() {
  const runtime = useProjectQueryRuntime();
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  return runtime;
}

export function useProjectDetailQuery(projectId: string, enabled: boolean, specialOwnerOwnsKey: boolean, role: Role = "admin"): UseQueryResult<ProjectDetail, Error> {
  const queryClient = useQueryClient();
  const runtime = useOwnedSnapshot();
  const ledgerVersion = useProjectMembershipLedgerVersion(projectId);
  const key = projectDataKeys.detail(projectId);
  const owned = specialOwnerOwnsKey || runtime.isOwned(key) || isProjectQueryLedgerPending(queryClient, key);
  const query = useQuery({
    ...projectDetailQueryOptions(projectId), enabled: enabled && !runtime.isProjectRemoved(projectId), staleTime: 15_000,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const detail = role === "external_editor"
        ? externalProjectDetailToWorkspace(await externalApiGet("project-detail", detailPath(projectId), signal) as ExternalProjectDetailDto) as ProjectDetail
        : await apiGet<ProjectDetail>(detailPath(projectId), { signal });
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return detail;
    },
    refetchInterval: owned ? false : 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: owned ? false : true, refetchOnReconnect: owned ? false : true,
  });
  void ledgerVersion;
  return { ...query, data: query.data ? applyProjectMembershipOverlay(query.data, getProjectMembershipTokens(queryClient, projectId)) : query.data } as UseQueryResult<ProjectDetail, Error>;
}

export function useProjectAssetsQuery(projectId: string, collectionKind: CollectionKind, enabled: boolean, specialOwnerOwnsKey: boolean, role: Role = "admin"): UseQueryResult<WorkspaceAsset[], Error> {
  const queryClient = useQueryClient();
  const runtime = useOwnedSnapshot();
  const key = projectDataKeys.assets(projectId, collectionKind);
  const owned = specialOwnerOwnsKey || runtime.isOwned(key) || isProjectQueryLedgerPending(queryClient, key);
  return useQuery({
    ...projectAssetsQueryOptions(projectId, collectionKind), enabled: enabled && !runtime.isProjectRemoved(projectId), staleTime: 15_000,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const response = role === "external_editor"
        ? await externalApiGet("asset-list", assetsPath(projectId, collectionKind), signal) as { assets: WorkspaceAsset[] }
        : await apiGet<AssetsResponse>(assetsPath(projectId, collectionKind), { signal });
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return response.assets;
    },
    refetchInterval: owned ? false : 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: owned ? false : true, refetchOnReconnect: owned ? false : true,
  });
}

export function useProjectCollaborationSummaryQuery(projectId: string, enabled: boolean, specialOwnerOwnsKey = false): UseQueryResult<ProjectCollaborationSummary, Error> {
  const queryClient = useQueryClient();
  const runtime = useOwnedSnapshot();
  const ledgerVersion = useProjectMembershipLedgerVersion(projectId);
  const key = projectDataKeys.collaborationSummary(projectId);
  const owned = specialOwnerOwnsKey || runtime.isOwned(key) || isProjectQueryLedgerPending(queryClient, key);
  const query = useQuery({
    ...projectCollaborationSummaryQueryOptions(projectId), enabled: enabled && !runtime.isProjectRemoved(projectId), staleTime: 15_000,
    refetchInterval: owned ? false : 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: owned ? false : true, refetchOnReconnect: owned ? false : true,
  });
  void ledgerVersion;
  return { ...query, data: query.data ? applyProjectCollaborationSummaryMembershipOverlay(query.data, getProjectMembershipTokens(queryClient, projectId)) : query.data } as UseQueryResult<ProjectCollaborationSummary, Error>;
}

export function useProjectSubtasksQuery(projectId: string, enabled: boolean, specialOwnerOwnsKey = false, role: Role = "admin"): UseQueryResult<ProjectSubtask[], Error> {
  const contextClient = useContext(QueryClientContext);
  const [fallbackClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const queryClient = contextClient ?? fallbackClient;
  const runtime = contextClient ? getProjectQueryRuntime(contextClient) : undefined;
  const subscribe = runtime?.subscribe ?? (() => () => undefined);
  const getSnapshot = runtime?.getSnapshot ?? (() => 0);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const key = projectDataKeys.subtasks(projectId);
  const owned = specialOwnerOwnsKey || Boolean(runtime?.isOwned(key)) || isProjectQueryLedgerPending(queryClient, key);
  useEffect(() => {
    if (runtime?.principalTerminal) queryClient.removeQueries({ queryKey: key, exact: true });
  }, [key, queryClient, runtime?.principalTerminal]);
  return useQuery({
    ...projectSubtasksQueryOptions(projectId), enabled: enabled && !runtime?.isProjectRemoved(projectId) && !runtime?.principalTerminal, staleTime: 15_000,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const response = role === "external_editor"
        ? await externalApiGet("checklist", subtasksPath(projectId), signal) as { subtasks?: ProjectSubtask[] }
        : await apiGet<ProjectSubtasksResponse>(subtasksPath(projectId), { signal });
      if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return (response.subtasks ?? []).slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    },
    refetchInterval: owned ? false : 30_000, refetchIntervalInBackground: false, refetchOnWindowFocus: owned ? false : true, refetchOnReconnect: owned ? false : true, retry: projectQueryRetry,
  }, queryClient) as UseQueryResult<ProjectSubtask[], Error>;
}

export function usePassiveRawAssetsQuery(projectId: string, enabled: boolean, role: Role = "admin"): UseQueryResult<WorkspaceAsset[], Error> {
  const runtime = useOwnedSnapshot();
  return useQuery({
    ...projectAssetsQueryOptions(projectId, "raw"), enabled: enabled && !runtime.isProjectRemoved(projectId), staleTime: Infinity,
    queryFn: async ({ signal, client }: QueryFunctionContext) => {
      const response = role === "external_editor"
        ? await externalApiGet("asset-list", assetsPath(projectId, "raw"), signal) as { assets: WorkspaceAsset[] }
        : await apiGet<AssetsResponse>(assetsPath(projectId, "raw"), { signal });
      if (getProjectQueryRuntime(client)?.isProjectRemoved(projectId)) throw removedDataError();
      return response.assets;
    },
    refetchInterval: false, refetchIntervalInBackground: false, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: false,
  });
}

export type ProjectInvalidation = { projectId: string; resources: ProjectDataResource[] };

export type ProjectCollaborationSummary = {
  project: { id: string; street: string; stageKey: ProjectDetail["stageKey"] };
  members: Array<Pick<ProjectMember, "id" | "userId" | "roleOnProject" | "name" | "active">>;
};
export type ProjectAssignmentCandidate = { id: string; name: string; email: string; globalRole: "admin" | "photographer" | "editor" | "external_editor"; active: true };
export type ProjectAssignmentCandidates = { photographers: ProjectAssignmentCandidate[]; editors: ProjectAssignmentCandidate[] };

function isProjectCollaborationSummary(value: unknown, projectId: string): value is ProjectCollaborationSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (Object.keys(summary).sort().join(",") !== "members,project" || !summary.project || typeof summary.project !== "object" || Array.isArray(summary.project) || !Array.isArray(summary.members)) return false;
  const project = summary.project as Record<string, unknown>;
  if (Object.keys(project).sort().join(",") !== "id,stageKey,street" || project.id !== projectId || typeof project.street !== "string" || typeof project.stageKey !== "string" || !(project.stageKey === "editing" || isStageKey(project.stageKey))) return false;
  return summary.members.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const member = value as Record<string, unknown>;
    return Object.keys(member).sort().join(",") === "active,id,name,roleOnProject,userId"
      && typeof member.id === "string" && typeof member.userId === "string" && typeof member.name === "string"
      && (member.roleOnProject === "photographer" || member.roleOnProject === "editor") && typeof member.active === "boolean";
  });
}

const collaborationDataGenerations = new WeakMap<QueryClient, Map<string, number>>();
const commentReadStateRequestSequences = new WeakMap<QueryClient, Map<string, number>>();
const commentReadStateWriteSequences = new WeakMap<QueryClient, Map<string, number>>();
function collaborationGenerationMap(queryClient: QueryClient) {
  let generations = collaborationDataGenerations.get(queryClient);
  if (!generations) { generations = new Map(); collaborationDataGenerations.set(queryClient, generations); }
  return generations;
}
export function projectCollaborationDataGeneration(queryClient: QueryClient, projectId: string) { return collaborationGenerationMap(queryClient).get(projectId) ?? 0; }
function bumpProjectCollaborationDataGeneration(queryClient: QueryClient, projectId: string) {
  const generations = collaborationGenerationMap(queryClient);
  const next = (generations.get(projectId) ?? 0) + 1; generations.set(projectId, next); return next;
}
function commentSequenceMap(store: WeakMap<QueryClient, Map<string, number>>, queryClient: QueryClient) {
  let sequences = store.get(queryClient);
  if (!sequences) { sequences = new Map(); store.set(queryClient, sequences); }
  return sequences;
}
export function nextProjectCommentReadStateRequestSequence(queryClient: QueryClient, projectId: string) {
  const sequences = commentSequenceMap(commentReadStateRequestSequences, queryClient);
  const next = (sequences.get(projectId) ?? 0) + 1; sequences.set(projectId, next); return next;
}
export function projectCommentReadStateWriteSequence(queryClient: QueryClient, projectId: string) {
  return commentSequenceMap(commentReadStateWriteSequences, queryClient).get(projectId) ?? Number.NEGATIVE_INFINITY;
}
export function setProjectCommentReadStateWriteSequence(queryClient: QueryClient, projectId: string, sequence: number) {
  commentSequenceMap(commentReadStateWriteSequences, queryClient).set(projectId, sequence);
}
export function commentReadStateSequenceReset(queryClient: QueryClient, projectId: string) {
  commentReadStateRequestSequences.get(queryClient)?.delete(projectId);
  commentReadStateWriteSequences.get(queryClient)?.delete(projectId);
}

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
  const keys = resources.map((resource) => projectResourceKey(invalidation.projectId, resource));
  const queuedIndexes = new Set(resources.map((resource, index) => ((resource.kind === "assets" || resource.kind === "detail" || resource.kind === "collaboration-summary") && isProjectQueryLedgerPending(queryClient, keys[index]!)) ? index : -1).filter((index) => index >= 0));
  const queuedResources = resources.filter((_, index) => queuedIndexes.has(index));
  const immediateResources = resources.filter((_, index) => !queuedIndexes.has(index));
  if (queuedResources.length) queueLedgerInvalidation(queryClient, { ...invalidation, resources: queuedResources }, publish);
  if (!immediateResources.length) return;
  const immediateKeys = immediateResources.map((resource) => projectResourceKey(invalidation.projectId, resource));
  await Promise.all(immediateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" })));
  // A sibling tab may have deferred the same exact key while this tab owned a
  // membership/asset ledger. The local commit has now performed the authoritative
  // invalidation, so consume that remote marker instead of leaving it stranded until
  // an unrelated owner release.
  for (const queryKey of immediateKeys) runtime?.takeDeferred(queryKey);
  if (publish) runtime?.publish({ version: 1, type: "project-data-invalidated", projectId: invalidation.projectId, committedAt: new Date().toISOString(), resources: immediateResources });
}

export async function invalidateActiveProjectDetails(queryClient: QueryClient, publish = true): Promise<void> {
  const active = queryClient.getQueryCache().getAll().filter((query) => query.queryKey.length === 3 && query.queryKey[0] === "project-data" && query.queryKey[2] === "detail" && query.getObserversCount() > 0);
  await Promise.all(active.map((query) => queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "active" })));
  if (publish) getProjectQueryRuntime(queryClient)?.publish(createActiveProjectDetailsInvalidatedMessage());
}

export async function purgeProjectData(queryClient: QueryClient, projectId: string): Promise<void> {
  bumpProjectCollaborationDataGeneration(queryClient, projectId);
  commentReadStateSequenceReset(queryClient, projectId);
  discardAssetLedger(queryClient, projectId);
  discardProjectMembershipLedger(queryClient, projectId);
  const prefix = projectDataKeys.project(projectId);
  await queryClient.cancelQueries({ queryKey: prefix });
  queryClient.removeQueries({ queryKey: prefix });
}

/** Collaboration-wide tombstone: increment/reset first, then cancel and remove private data. */
export async function purgeProjectCollaborationData(queryClient: QueryClient, projectId: string): Promise<void> {
  bumpProjectCollaborationDataGeneration(queryClient, projectId);
  commentReadStateSequenceReset(queryClient, projectId);
  discardProjectMembershipLedger(queryClient, projectId);
  await queryClient.cancelQueries({ queryKey: projectDataKeys.subtasks(projectId), exact: true });
  queryClient.removeQueries({ queryKey: projectDataKeys.subtasks(projectId), exact: true });
  await queryClient.cancelQueries({ queryKey: projectDataKeys.collaborationSummary(projectId), exact: true });
  queryClient.removeQueries({ queryKey: projectDataKeys.collaborationSummary(projectId), exact: true });
  await queryClient.cancelQueries({ queryKey: projectDataKeys.commentsRoot(projectId) });
  queryClient.removeQueries({ queryKey: projectDataKeys.commentsRoot(projectId) });
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
  const affectedProjects = new Set<string>(membershipLedgerMap(queryClient).keys());
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey;
    if (key[0] === "project-data" && typeof key[1] === "string") affectedProjects.add(key[1]);
  }
  for (const projectId of affectedProjects) {
    bumpProjectCollaborationDataGeneration(queryClient, projectId);
    commentReadStateSequenceReset(queryClient, projectId);
  }
  discardAllProjectMembershipLedgers(queryClient);
  await queryClient.cancelQueries();
  queryClient.clear();
}

type MembershipLedgerToken = {
  id: number;
  cell: string;
  roleOnProject: ProjectMemberRole;
  userId: string;
  intent: "add" | "remove";
  base: ProjectMember | null;
  optimistic: ProjectMember | null;
  status: "pending" | "committed";
  committed: ProjectMember | null | undefined;
  cleared: number;
};
type MembershipLedgerState = { queryClient: QueryClient; projectId: string; nextId: number; version: number; tokens: MembershipLedgerToken[]; queued: ProjectInvalidation | null; queuedPublish: boolean };
const membershipLedgers = new WeakMap<QueryClient, Map<string, MembershipLedgerState>>();
const membershipListeners = new WeakMap<QueryClient, Map<string, Set<() => void>>>();

function membershipLedgerMap(queryClient: QueryClient) {
  let map = membershipLedgers.get(queryClient);
  if (!map) { map = new Map(); membershipLedgers.set(queryClient, map); }
  return map;
}
function membershipCell(roleOnProject: ProjectMemberRole, userId: string) { return `${roleOnProject}:${userId}`; }
function membershipState(queryClient: QueryClient, projectId: string) { return membershipLedgerMap(queryClient).get(projectId); }
export function getProjectMembershipTokens(queryClient: QueryClient, projectId: string): readonly MembershipLedgerToken[] { return membershipState(queryClient, projectId)?.tokens ?? []; }
export function useProjectMembershipLedgerVersion(projectId: string) {
  const queryClient = useQueryClient();
  const map = membershipLedgerMap(queryClient);
  let listenerMap = membershipListeners.get(queryClient);
  if (!listenerMap) { listenerMap = new Map(); membershipListeners.set(queryClient, listenerMap); }
  const key = projectId;
  const subscribe = useCallback((listener: () => void) => {
    const listeners = listenerMap!.get(key) ?? new Set<() => void>();
    listenerMap!.set(key, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, [key, listenerMap]);
  const getSnapshot = useCallback(() => map.get(key)?.version ?? 0, [key, map]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
function notifyMembershipLedger(state: MembershipLedgerState) {
  state.version += 1;
  // The listener store is attached to the QueryClient, not to a token, so the first token
  // can wake components that subscribed while the ledger was still empty.
  for (const listener of membershipListeners.get(state.queryClient)?.get(state.projectId) ?? []) listener();
}

type MembersContainer = { members: Array<{ id: string; userId: string; roleOnProject: ProjectMemberRole; assignedSubtaskCount?: number }> };
export function applyProjectMembershipOverlay<T extends MembersContainer>(canonicalData: T, tokens: readonly MembershipLedgerToken[]): T {
  let members = [...(Array.isArray(canonicalData.members) ? canonicalData.members : [])];
  for (const token of tokens) {
    members = members.filter((member) => membershipCell(member.roleOnProject, member.userId) !== token.cell);
    if (token.intent === "add") {
      const next = token.status === "committed" ? token.committed : token.optimistic;
      if (next) members.push(next as T["members"][number]);
    }
    if (token.intent === "remove" && token.status === "committed" && token.cleared > 0) {
      members = members.map((member) => member.userId === token.userId && "assignedSubtaskCount" in member
        ? { ...member, assignedSubtaskCount: Math.max(0, (member.assignedSubtaskCount ?? 0) - token.cleared) }
        : member);
    }
  }
  return { ...canonicalData, members };
}

type ProjectCollaborationSummaryMember = ProjectCollaborationSummary["members"][number];
function projectCollaborationSummaryMember(member: Pick<ProjectMember, "id" | "userId" | "roleOnProject" | "name" | "active">): ProjectCollaborationSummaryMember {
  return { id: member.id, userId: member.userId, roleOnProject: member.roleOnProject, name: member.name, active: member.active };
}

export function applyProjectCollaborationSummaryMembershipOverlay(canonicalData: ProjectCollaborationSummary, tokens: readonly MembershipLedgerToken[]): ProjectCollaborationSummary {
  let members = canonicalData.members.map(projectCollaborationSummaryMember);
  for (const token of tokens) {
    members = members.filter((member) => membershipCell(member.roleOnProject, member.userId) !== token.cell);
    if (token.intent === "add") {
      const next = token.status === "committed" ? token.committed : token.optimistic;
      if (next) members.push(projectCollaborationSummaryMember(next));
    }
  }
  return { ...canonicalData, members };
}

export type ProjectMembershipMutation = {
  tokenId: number;
  commit: (membership?: ProjectMember, subtaskAssignmentsCleared?: number) => Promise<void>;
  fail: () => Promise<void>;
  conflict: (membership: ProjectMember | null) => Promise<void>;
};

function mergeMembershipLedgerIntoCaches(queryClient: QueryClient, projectId: string, tokens: readonly MembershipLedgerToken[]) {
  const detailKey = projectDataKeys.detail(projectId);
  queryClient.setQueryData<ProjectDetail>(detailKey, (current) => current ? applyProjectMembershipOverlay(current, tokens) : current);
  const summaryKey = projectDataKeys.collaborationSummary(projectId);
  queryClient.setQueryData<ProjectCollaborationSummary>(summaryKey, (current) => current ? applyProjectCollaborationSummaryMembershipOverlay(current, tokens) : current);
}

function restoreMembershipTokenInCaches(queryClient: QueryClient, projectId: string, token: MembershipLedgerToken) {
  const restore = <T extends MembersContainer>(current: T | undefined): T | undefined => {
    if (!current) return current;
    const members = current.members.filter((member) => membershipCell(member.roleOnProject, member.userId) !== token.cell);
    return { ...current, members: token.base ? [...members, token.base as T["members"][number]] : members };
  };
  const restoreSummary = (current: ProjectCollaborationSummary | undefined): ProjectCollaborationSummary | undefined => {
    if (!current) return current;
    const members = current.members.map(projectCollaborationSummaryMember).filter((member) => membershipCell(member.roleOnProject, member.userId) !== token.cell);
    return { ...current, members: token.base ? [...members, projectCollaborationSummaryMember(token.base)] : members };
  };
  queryClient.setQueryData<ProjectDetail>(projectDataKeys.detail(projectId), (current) => restore(current));
  queryClient.setQueryData<ProjectCollaborationSummary>(projectDataKeys.collaborationSummary(projectId), (current) => restoreSummary(current));
}

function replaceMembershipCellInCaches(queryClient: QueryClient, projectId: string, roleOnProject: ProjectMemberRole, userId: string, membership: ProjectMember | null) {
  const cell = membershipCell(roleOnProject, userId);
  queryClient.setQueryData<ProjectDetail>(projectDataKeys.detail(projectId), (current) => current ? { ...current, members: [...current.members.filter((member) => membershipCell(member.roleOnProject, member.userId) !== cell), ...(membership ? [membership] : [])] } : current);
  queryClient.setQueryData<ProjectCollaborationSummary>(projectDataKeys.collaborationSummary(projectId), (current) => current ? { ...current, members: [...current.members.map(projectCollaborationSummaryMember).filter((member) => membershipCell(member.roleOnProject, member.userId) !== cell), ...(membership ? [projectCollaborationSummaryMember(membership)] : [])] } : current);
}

export async function beginProjectMembershipMutation(
  queryClient: QueryClient,
  projectId: string,
  roleOnProject: ProjectMemberRole,
  userId: string,
  intent: "add" | "remove",
  optimistic: ProjectMember | null,
): Promise<ProjectMembershipMutation> {
  let state = membershipState(queryClient, projectId);
  if (!state) {
    state = { queryClient, projectId, nextId: 1, version: 0, tokens: [], queued: null, queuedPublish: false };
    membershipLedgerMap(queryClient).set(projectId, state);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: projectDataKeys.detail(projectId), exact: true }),
      queryClient.cancelQueries({ queryKey: projectDataKeys.collaborationSummary(projectId), exact: true }),
    ]);
    // A collaboration purge may have discarded this freshly-created owner while the
    // cancellation awaits. Do not let the late mutation setup recreate private overlay state.
    if (membershipLedgerMap(queryClient).get(projectId) !== state) throw removedDataError();
  }
  if (state.tokens.some((candidate) => candidate.cell === membershipCell(roleOnProject, userId) && candidate.status === "pending")) throw new Error("This assignment is already being updated.");
  const detail = queryClient.getQueryData<ProjectDetail>(projectDataKeys.detail(projectId));
  const base = detail?.members.find((member) => membershipCell(member.roleOnProject, member.userId) === membershipCell(roleOnProject, userId)) ?? null;
  const token: MembershipLedgerToken = { id: state.nextId++, cell: membershipCell(roleOnProject, userId), roleOnProject, userId, intent, base, optimistic, status: "pending", committed: undefined, cleared: 0 };
  state.tokens.push(token);
  mergeMembershipLedgerIntoCaches(queryClient, projectId, state.tokens);
  notifyMembershipLedger(state);
  const settle = async (status: "committed" | "failed", membership?: ProjectMember, cleared = 0) => {
    const map = membershipLedgerMap(queryClient);
    const active = map.get(projectId);
    if (!active || !active.tokens.some((candidate) => candidate.id === token.id)) return;
    if (status === "failed") { restoreMembershipTokenInCaches(queryClient, projectId, token); active.tokens = active.tokens.filter((candidate) => candidate.id !== token.id); }
    else {
      const current = active.tokens.find((candidate) => candidate.id === token.id);
      if (current) { current.status = "committed"; current.committed = membership === undefined ? (current.intent === "add" ? current.optimistic : null) : membership; current.cleared = cleared; }
    }
    const pending = active.tokens.some((candidate) => candidate.status === "pending");
    if (pending) { mergeMembershipLedgerIntoCaches(queryClient, projectId, active.tokens); notifyMembershipLedger(active); return; }
    const committedTokens = active.tokens.filter((candidate) => candidate.status === "committed");
    mergeMembershipLedgerIntoCaches(queryClient, projectId, active.tokens);
    const queued = active.queued;
    const publish = active.queuedPublish || committedTokens.length > 0;
    map.delete(projectId);
    notifyMembershipLedger(active);
    if (queued) await invalidateProjectResources(queryClient, queued, publish);
    else if (committedTokens.length) await invalidateProjectResources(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "collaboration-summary" }] }, true);
    const locallyCovered = new Set((queued?.resources ?? []).map((resource) => JSON.stringify(resource)));
    if (committedTokens.length) {
      locallyCovered.add(JSON.stringify({ kind: "detail" }));
      locallyCovered.add(JSON.stringify({ kind: "collaboration-summary" }));
    }
    const runtime = getProjectQueryRuntime(queryClient);
    for (const resource of [{ kind: "detail" } as const, { kind: "collaboration-summary" } as const]) {
      if (locallyCovered.has(JSON.stringify(resource))) continue;
      const queryKey = projectResourceKey(projectId, resource);
      if (runtime?.takeDeferred(queryKey)) await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" });
    }
  };
  const conflict = async (currentMembership: ProjectMember | null) => {
    const active = membershipState(queryClient, projectId);
    if (!active || !active.tokens.some((candidate) => candidate.id === token.id)) return;
    restoreMembershipTokenInCaches(queryClient, projectId, token);
    active.tokens = active.tokens.filter((candidate) => candidate.id !== token.id);
    replaceMembershipCellInCaches(queryClient, projectId, roleOnProject, userId, currentMembership);
    const pending = active.tokens.some((candidate) => candidate.status === "pending");
    if (pending) { queueMembershipLedgerInvalidation(queryClient, { projectId, resources: [{ kind: "detail" }, { kind: "collaboration-summary" }] }, true); mergeMembershipLedgerIntoCaches(queryClient, projectId, active.tokens); notifyMembershipLedger(active); return; }
    const queued = active.queued;
    membershipLedgerMap(queryClient).delete(projectId);
    notifyMembershipLedger(active);
    await invalidateProjectResources(queryClient, queued ?? { projectId, resources: [{ kind: "detail" }, { kind: "collaboration-summary" }] }, true);
  };
  return { tokenId: token.id, commit: (membership, cleared) => settle("committed", membership, cleared), fail: () => settle("failed"), conflict };
}

function queueMembershipLedgerInvalidation(queryClient: QueryClient, invalidation: ProjectInvalidation, publish: boolean) {
  const state = membershipState(queryClient, invalidation.projectId);
  if (!state) return;
  if (!state.queued) state.queued = { projectId: invalidation.projectId, resources: [] };
  for (const resource of invalidation.resources) {
    if (resource.kind !== "detail" && resource.kind !== "collaboration-summary") continue;
    if (!state.queued.resources.some((item) => JSON.stringify(item) === JSON.stringify(resource))) state.queued.resources.push(resource);
  }
  state.queuedPublish ||= publish;
}

function discardProjectMembershipLedger(queryClient: QueryClient, projectId: string) { membershipLedgerMap(queryClient).delete(projectId); }
function discardAllProjectMembershipLedgers(queryClient: QueryClient) { membershipLedgers.get(queryClient)?.clear(); }

export type AssetPatch = { selected?: boolean } & ReviewPatch;
type LedgerToken = { id: number; patch: AssetPatch; status: "pending" | "committed"; hasData: boolean };
type CoordinateBase = { assetId: string; field: keyof AssetPatch; value: unknown };
type LedgerState = { nextId: number; tokens: LedgerToken[]; bases: Map<string, CoordinateBase>; queued: ProjectInvalidation | null; queuedPublish: boolean };
const ledgers = new WeakMap<QueryClient, Map<string, LedgerState>>();

function ledgerMap(queryClient: QueryClient) { let map = ledgers.get(queryClient); if (!map) { map = new Map(); ledgers.set(queryClient, map); } return map; }
function ledgerKey(queryKey: QueryKey) { return JSON.stringify(queryKey); }
export function isProjectQueryLedgerPending(queryClient: QueryClient, queryKey: QueryKey) {
  const assetPending = (ledgers.get(queryClient)?.get(ledgerKey(queryKey))?.tokens.length ?? 0) > 0;
  const projectId = queryKey[0] === "project-data" && typeof queryKey[1] === "string" ? queryKey[1] : undefined;
  const membershipPending = projectId !== undefined && (queryKey[2] === "detail" || queryKey[2] === "collaboration-summary") && (membershipState(queryClient, projectId)?.tokens.length ?? 0) > 0;
  return assetPending || membershipPending;
}

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
    if (resource.kind !== "assets") continue;
    const key = projectResourceKey(invalidation.projectId, resource);
    const state = map.get(ledgerKey(key));
    if (!state) continue;
    if (!state.queued) state.queued = { projectId: invalidation.projectId, resources: [] };
    if (!state.queued.resources.some((item) => JSON.stringify(item) === JSON.stringify(resource))) state.queued.resources.push(resource);
    state.queuedPublish ||= publish;
  }
  queueMembershipLedgerInvalidation(queryClient, invalidation, publish);
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
