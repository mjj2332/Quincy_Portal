import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CollectionKind, MoveProjectStageRequest, MoveProjectStageResponse, Role } from "@quincy/shared";
import { type ProjectStageKey, useStages } from "../lib/stages";
import { Lightbox } from "../components/Lightbox";
import { PhotoGrid, type ReviewPatch, type WorkspaceAsset } from "../components/PhotoGrid";
import { UploadDropzone } from "../components/UploadDropzone";
import { ExternalEditedUpload } from "../components/ExternalEditedUpload";
import { CollectionPanel } from "../components/CollectionPanel";
import { ApiError, apiDelete, apiGet, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { clearToasts, pushToast as toast } from "../lib/toast-store";
import { ToastViewport } from "../components/quincy/ToastViewport";
import { InternalLink } from "../components/InternalLink";
import { ProjectCollaborationPanel } from "../components/ProjectCollaborationPanel";
import { ProjectHeader } from "../components/ProjectHeader";
import { buttonClasses } from "../components/quincy/Button";
import { Eyebrow } from "../components/quincy/Eyebrow";
import { EmptyState } from "../components/quincy/EmptyState";
import {
  beginAssetOptimisticMutation, classifyProjectAccessError, discardAssetLedgerForResource, invalidateProjectResources, invalidateProjectSurfaces,
  projectAssetsQueryOptions, projectCollaborationSummaryQueryOptions, projectDataKeys, projectDetailQueryOptions, purgeProjectCollaborationData, purgeProjectData,
  clearPrincipalProjectData, usePassiveRawAssetsQuery, useProjectAssetsQuery, useProjectDetailQuery,
  useProjectCollaborationSummaryQuery,
  useProjectAccessTermination,
  type ProjectDetail,
} from "../lib/project-data";
import { projectCommentsInfiniteQueryOptions, useProjectCommentsCacheQuery } from "../lib/project-comments";
import { createProjectDataInvalidationMessage, getProjectQueryRuntime, useProjectQueryRuntime } from "../lib/project-query-sync";
import type { ProjectDataResource } from "../lib/project-query-sync";
import { submitStageMoveWithConfirmation } from "../lib/stage-move";
import { EditorFolderAttentionNotice } from "../components/EditorFolderAttentionNotice";

type AssetDeleteResponse = { ok: boolean; deletedAssetIds: string[]; deletedObjects: number; dropboxDeleted: boolean; dropboxOutcome?: "removed" | "alreadyGone" | "claimLost" | "failed"; dropboxReason?: string };
// Edited uploads remain invisible until their existing publication poll reports them ready.
type IngestStatus = { expectedCount: number | null; receivedCount: number; mismatch: boolean };
type Job = { id: string; kind: "autohdr_api_send" | "autohdr" | "fetch_edited" | "autohdr_scaffold" | "editor_reconcile" | "editor_sync" | "manual_edited_publish" | "manual_raw_publish"; status: "queued" | "running" | "done" | "failed" | "stuck"; error: string | null; correlationId: string | null; createdAt: string; updatedAt: string };
type JobsResponse = { jobs: Job[] };
type DropboxSyncResponse = { raw: { jobId: string } | { skipped: "no_raw_folder" | "not_permitted" | "error"; message?: string }; edited: { jobId: string } | { skipped: "not_ready" | "not_admin" | "error"; message?: string } | { blocked: { code: string; message: string } } };
interface AutoHdrStatusResponse { handoff: { id: string; generation: number; state: "starting" | "started" | "blocked" | "retired" | "failed"; mappingState: "pending_discovery" | "active" | "blocked_collision" | "retired"; finalPath: string | null; diagnostic: string | null } | null; }

export function projectAssetsForRender(data: WorkspaceAsset[] | undefined, error: unknown, kind: CollectionKind): WorkspaceAsset[] {
  return error && classifyProjectAccessError(error, "assets", kind) ? [] : data ?? [];
}

function collectionLabel(value: string) { return value === "raw" ? "RAW" : value.charAt(0).toUpperCase() + value.slice(1); }
function activeJob(job: Job) { return job.status === "queued" || job.status === "running"; }
function isExpectedReadCancellation(reason: unknown) { return reason instanceof Error && (reason.name === "AbortError" || reason.name === "CancelledError" || reason.message === "CancelledError"); }

export function deletedAssetClosesLightbox(openAssetId: string | null, deletedAssetIds: string[]): boolean { return openAssetId !== null && deletedAssetIds.includes(openAssetId); }
type AssetDeleteResult = { deletedAssetIds: string[]; dropboxOutcome?: "removed" | "alreadyGone" | "claimLost" | "failed" };
export function computeBulkDeleteOutcome(assetIds: string[], results: PromiseSettledResult<AssetDeleteResult>[]) {
  const succeededIds = results.flatMap((result) => result.status === "fulfilled" ? result.value.deletedAssetIds : []);
  const succeededSet = new Set(succeededIds);
  const failedIds = assetIds.filter((id) => !succeededSet.has(id));
  const dropboxCleanupWarnings = results.filter((result) => result.status === "fulfilled" && (result.value.dropboxOutcome === "failed" || result.value.dropboxOutcome === "claimLost")).length;
  return { succeededIds: [...succeededSet], failedIds, dropboxCleanupWarnings };
}

type ProjectWorkspaceProps = { projectId: string; notice?: string | null; onNoticeShown?: () => void; collaborationOpenSignal?: number; onCollaborationOpenSignalConsumed?: (signal: number) => void };
type TerminalState = { projectId: string; scope: "principal" | "project"; message: string };
type AccessFailureResource = "detail" | "activity" | "assets" | "comments" | "comment-read-marker" | "nested-comment" | "collaboration-summary";

function ProjectWorkspaceView(props: ProjectWorkspaceProps) {
  const { projectId, notice, onNoticeShown, collaborationOpenSignal, onCollaborationOpenSignalConsumed } = props;
  const queryClient = useQueryClient();
  const runtime = useProjectQueryRuntime();
  const runtimeVersion = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const { can, role } = useCapabilities();
  const canAdminBackend = can("adminBackend");
  const canViewEdited = can("viewEdited");
  const terminateOnUnauthorized = useProjectAccessTermination();
  const [activeTab, setActiveTab] = useState<CollectionKind>("raw");
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const [lightboxOrderIds, setLightboxOrderIds] = useState<string[] | null>(null);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [autohdrStatus, setAutohdrStatus] = useState<AutoHdrStatusResponse["handoff"]>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [run, setRun] = useState(0);
  const [manualReadyFor, setManualReadyFor] = useState<number | null>(null);
  const [queryReadyFor, setQueryReadyFor] = useState<number | null>(null);
  const [terminal, setTerminal] = useState<TerminalState | null>(null);
  const [initialDetailProbe, setInitialDetailProbe] = useState(false);
  const [collaborationAccess, setCollaborationAccess] = useState<{ projectId: string; only: boolean; unavailable: boolean }>({ projectId, only: false, unavailable: false });
  const collaborationOnly = collaborationAccess.projectId === projectId && collaborationAccess.only;
  const collaborationUnavailable = collaborationAccess.projectId === projectId && collaborationAccess.unavailable;
  const setCollaborationOnly = useCallback((only: boolean) => setCollaborationAccess((current) => ({ projectId, only, unavailable: current.projectId === projectId ? current.unavailable : false })), [projectId]);
  const setCollaborationUnavailable = useCallback((unavailable: boolean) => setCollaborationAccess((current) => ({ projectId, only: unavailable ? false : current.projectId === projectId ? current.only : false, unavailable })), [projectId]);
  const [collectionDenied, setCollectionDenied] = useState<Set<CollectionKind>>(() => new Set());
  const [stageKeyForManual, setStageKeyForManual] = useState<ProjectStageKey | null>(null);
  const currentProjectIdRef = useRef(projectId);
  const manualOwnerRef = useRef<{ controller: AbortController; run: number; projectId: string } | null>(null);
  const runRef = useRef(0);
  const terminalRef = useRef<TerminalState | null>(null);
  const activeJobTimerRef = useRef<number | undefined>(undefined);
  const legacyTimerRef = useRef<number | undefined>(undefined);
  const specialOwnerReleasesRef = useRef(new Map<string, () => void>());
  const syncDelayTimersRef = useRef<Set<number>>(new Set());
  const autohdrObservedRef = useRef<{ handoffId: string; jobId: string } | null>(null);
  const initialTabHandledRef = useRef<number | null>(null);
  const transientNoticeRef = useRef(new Set<string>());
  currentProjectIdRef.current = projectId;
  terminalRef.current = terminal;

  useEffect(() => {
    const nextRun = runRef.current + 1; runRef.current = nextRun; setRun(nextRun);
    manualOwnerRef.current?.controller.abort();
    for (const timer of syncDelayTimersRef.current) window.clearTimeout(timer);
    syncDelayTimersRef.current.clear();
    if (activeJobTimerRef.current) window.clearInterval(activeJobTimerRef.current);
    if (legacyTimerRef.current) window.clearTimeout(legacyTimerRef.current);
    activeJobTimerRef.current = undefined; legacyTimerRef.current = undefined;
    const controller = new AbortController(); manualOwnerRef.current = { controller, run: nextRun, projectId };
    // Clears toasts unconditionally, on every mount including the first. The `notice` effect is
    // ordered deliberately *after* this one so that a notice raised on mount survives it (#117).
    setActiveTab("raw"); setOpenAssetId(null); setLightboxOrderIds(null); setIngest(null); setJobs([]); setAutohdrStatus(null); clearToasts();
    setManualReadyFor(null); setQueryReadyFor(null); setTerminal(null); setInitialDetailProbe(false); setCollaborationOnly(false); setCollaborationUnavailable(false); setCollectionDenied(new Set()); setStageKeyForManual(null); setIsSyncing(false); setIsSending(false);
    initialTabHandledRef.current = null; autohdrObservedRef.current = null;
    transientNoticeRef.current.clear();
    return () => { controller.abort(); for (const timer of syncDelayTimersRef.current) window.clearTimeout(timer); syncDelayTimersRef.current.clear(); };
  }, [projectId]);

  const onNoticeShownRef = useRef(onNoticeShown);
  onNoticeShownRef.current = onNoticeShown;
  // Ordered after the per-Project reset above, and that order is the whole fix (#117). Both effects
  // run on mount and React commits them in source order, so with the push first the reset's
  // `clearToasts()` wiped the notice on the very render that raised it — and `onNoticeShown` had
  // already fired, so the notice was consumed rather than deferred. A Staff member arriving after a
  // Stage change lost the confirmation with no way to tell whether the action landed. Reset first
  // means the outgoing Project's toasts are cleared and the notice lands in the cleared surface,
  // which is also what a Project switch carrying a notice needs.
  //
  // Keyed on the notice value alone, with the callback in a ref: `clearNotice` is reallocated on
  // every shell render (lib/app-router.tsx:194), so depending on its identity would re-run this on
  // unrelated renders and could show one notice twice.
  useEffect(() => { if (!notice) return; toast(notice); onNoticeShownRef.current?.(); }, [notice]);

  const isCurrent = useCallback(() => {
    const owner = manualOwnerRef.current;
    return Boolean(owner && !owner.controller.signal.aborted && owner.run === runRef.current && owner.projectId === projectId && !terminalRef.current && !runtime.isProjectRemoved(projectId) && currentProjectIdRef.current === projectId);
  }, [projectId, runtime]);
  const lifecycleOwnerActive = !terminal && !runtime.isProjectRemoved(projectId) && manualReadyFor !== null && manualReadyFor === queryReadyFor && canAdminBackend && jobs.some(activeJob);
  useEffect(() => {
    const desired = lifecycleOwnerActive
      ? [projectDataKeys.detail(projectId), projectDataKeys.assets(projectId, "edited")]
      : [];
    const desiredKeys = new Set(desired.map((queryKey) => JSON.stringify(queryKey)));
    for (const queryKey of desired) {
      const key = JSON.stringify(queryKey);
      if (!specialOwnerReleasesRef.current.has(key)) specialOwnerReleasesRef.current.set(key, runtime.acquireOwner(queryKey));
    }
    for (const [key, release] of specialOwnerReleasesRef.current) {
      if (desiredKeys.has(key)) continue;
      release();
      specialOwnerReleasesRef.current.delete(key);
    }
  }, [canAdminBackend, lifecycleOwnerActive, projectId, runtime, runtimeVersion]);
  useEffect(() => () => {
    for (const release of specialOwnerReleasesRef.current.values()) release();
    specialOwnerReleasesRef.current.clear();
  }, [projectId, runtime]);
  const accessFailure = useCallback((error: unknown, resource: AccessFailureResource, kind?: CollectionKind, initial = false) => {
    terminateOnUnauthorized(error);
    if (resource === "nested-comment") {
      if (error instanceof ApiError && error.status === 401) {
        if (isCurrent()) setTerminal({ projectId, scope: "principal", message: error.message });
        return;
      }
      if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) return;
      void apiGet(`/api/projects/${encodeURIComponent(projectId)}/comments?limit=50`).then(() => undefined).catch((confirmingError) => {
        if (confirmingError instanceof ApiError && confirmingError.status >= 500) return;
        const confirmed = classifyProjectAccessError(confirmingError, "comments");
        if (!isCurrent() || !confirmed) return;
        if (confirmed.scope === "principal") setTerminal({ projectId, scope: "principal", message: confirmingError instanceof Error ? confirmingError.message : "Your session is no longer available." });
        else if (confirmed.scope === "collaboration") { void purgeProjectCollaborationData(queryClient, projectId); setCollaborationUnavailable(true); }
        else setTerminal({ projectId, scope: "project", message: confirmingError instanceof Error ? confirmingError.message : "Project access is no longer available." });
      });
      return;
    }
    const classification = classifyProjectAccessError(error, resource, kind); if (!isCurrent()) return;
    if (!classification) {
      const key = `${resource}:${kind ?? ""}:${error instanceof Error ? error.message : String(error)}`;
      if (!transientNoticeRef.current.has(key)) { transientNoticeRef.current.add(key); toast(error instanceof Error ? error.message : "Project data could not be loaded.", "error"); }
      return;
    }
    if (classification.scope === "principal") setTerminal({ projectId, scope: "principal", message: error instanceof Error ? error.message : "Your session is no longer available." });
    else if (classification.scope === "collection") { const deniedKind = classification.collectionKind ?? kind; if (deniedKind) setCollectionDenied((current) => current.has(deniedKind) ? current : new Set(current).add(deniedKind)); if (activeTab === deniedKind) setActiveTab(deniedKind === "raw" && canViewEdited ? "edited" : "raw"); }
    else if (classification.scope === "collaboration") { void purgeProjectCollaborationData(queryClient, projectId); setCollaborationUnavailable(true); }
    else if (resource === "collaboration-summary" && classification.scope === "project") { void purgeProjectCollaborationData(queryClient, projectId); setTerminal({ projectId, scope: "project", message: error instanceof Error ? error.message : "Project access is no longer available." }); }
    else if (initial && resource === "detail" && error instanceof ApiError && error.status === 403) setInitialDetailProbe(true);
    else setTerminal({ projectId, scope: "project", message: error instanceof Error ? error.message : "Project access is no longer available." });
  }, [activeTab, canViewEdited, isCurrent, projectId, purgeProjectCollaborationData, queryClient, terminateOnUnauthorized]);

  const startCompanionBatch = useCallback((ownerRun: number) => {
    const owner = manualOwnerRef.current;
    if (!owner || owner.run !== ownerRun || owner.projectId !== projectId || owner.controller.signal.aborted || terminalRef.current) return;
    const ingestRequest = apiGet<IngestStatus>(`/api/projects/${encodeURIComponent(projectId)}/ingest-status`, { signal: owner.controller.signal });
    const jobsRequest = canAdminBackend ? apiGet<JobsResponse>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, { signal: owner.controller.signal }) : Promise.resolve(null);
    void Promise.allSettled([ingestRequest, jobsRequest]).then(([ingestResult, jobsResult]) => {
      if (!isCurrent() || runRef.current !== ownerRun) return;
      const failures = [ingestResult, jobsResult].filter((result): result is PromiseRejectedResult => result.status === "rejected" && !(result.reason instanceof Error && result.reason.name === "AbortError"));
      if (ingestResult.status === "fulfilled") setIngest(ingestResult.value);
      if (jobsResult.status === "fulfilled") setJobs(jobsResult.value?.jobs ?? []);
      setManualReadyFor(ownerRun);
      const unauthorized = failures.find((failure) => failure.reason instanceof ApiError && failure.reason.status === 401);
      if (unauthorized) accessFailure(unauthorized.reason, "detail");
      else if (failures[0]) accessFailure(failures[0].reason, "detail");
    });
  }, [accessFailure, canAdminBackend, isCurrent, projectId]);

  const forceDetailRead = useCallback(async () => {
    if (!isCurrent()) return undefined;
    const release = runtime.acquireOwner(projectDataKeys.detail(projectId));
    try { return await queryClient.fetchQuery({ ...projectDetailQueryOptions(projectId), staleTime: 0 }); } catch (reason) { if (!isExpectedReadCancellation(reason)) accessFailure(reason, "detail"); throw reason; } finally { release(); }
  }, [accessFailure, isCurrent, projectId, queryClient, runtime]);
  const canReadCollection = useCallback((kind: CollectionKind) => kind === "raw" ? can("viewRaw") : canViewEdited, [can, canViewEdited]);
  const forceAssetsRead = useCallback(async (kind: CollectionKind) => {
    if (!isCurrent() || !canReadCollection(kind)) return undefined;
    const release = runtime.acquireOwner(projectDataKeys.assets(projectId, kind));
    try { return await queryClient.fetchQuery({ ...projectAssetsQueryOptions(projectId, kind), staleTime: 0 }); } catch (reason) { if (!isExpectedReadCancellation(reason)) accessFailure(reason, "assets", kind); throw reason; } finally { release(); }
  }, [accessFailure, canReadCollection, isCurrent, projectId, queryClient, runtime]);
  const refreshIngest = useCallback(async () => {
    const owner = manualOwnerRef.current; if (!isCurrent() || !owner) return;
    try { const response = await apiGet<IngestStatus>(`/api/projects/${encodeURIComponent(projectId)}/ingest-status`, { signal: owner.controller.signal }); if (isCurrent()) setIngest(response); } catch (reason) { if (!(reason instanceof Error && reason.name === "AbortError")) accessFailure(reason, "detail"); }
  }, [accessFailure, isCurrent, projectId]);
  const refreshJobs = useCallback(async (): Promise<Job[]> => {
    const owner = manualOwnerRef.current; if (!isCurrent() || !owner || !canAdminBackend) return [];
    try { const response = await apiGet<JobsResponse>(`/api/projects/${encodeURIComponent(projectId)}/jobs`, { signal: owner.controller.signal }); if (isCurrent()) setJobs(response.jobs); return response.jobs; } catch (reason) { if (!(reason instanceof Error && reason.name === "AbortError")) accessFailure(reason, "detail"); return []; }
  }, [accessFailure, canAdminBackend, isCurrent, projectId]);
  const refreshAutohdrStatus = useCallback(async () => {
    const owner = manualOwnerRef.current; if (!isCurrent() || !owner || !canAdminBackend) return null;
    try { const response = await apiGet<AutoHdrStatusResponse>(`/api/projects/${encodeURIComponent(projectId)}/autohdr-status`, { signal: owner.controller.signal }); if (isCurrent()) setAutohdrStatus(response.handoff); return response.handoff; } catch (reason) { if (!(reason instanceof Error && reason.name === "AbortError")) accessFailure(reason, "detail"); return null; }
  }, [accessFailure, canAdminBackend, isCurrent, projectId]);
  const invalidate = useCallback((resources: ProjectDataResource[]) => invalidateProjectResources(queryClient, { projectId, resources }), [projectId, queryClient]);
  const onUploadComplete = useCallback(async (kind: "raw" | "edited") => { if (!isCurrent()) return; await invalidate([{ kind: "assets", collectionKind: kind }, { kind: "detail" }]); if (kind === "raw" && isCurrent()) await Promise.all([refreshIngest(), ...(canAdminBackend ? [refreshJobs()] : [])]); }, [canAdminBackend, invalidate, isCurrent, refreshIngest, refreshJobs]);
  const onDocumentsChanged = useCallback(async (kind: "floorplan" | "copy") => { await invalidate([{ kind: "assets", collectionKind: kind }, { kind: "detail" }, { kind: "activity" }]); }, [invalidate]);
  const onLinksChanged = useCallback(async () => { await invalidate([{ kind: "detail" }]); }, [invalidate]);

  useEffect(() => {
    if (!initialDetailProbe || terminal || !isCurrent()) return;
    const controller = new AbortController();
    void purgeProjectData(queryClient, projectId).then(() => {
      if (controller.signal.aborted || !isCurrent() || runRef.current !== run) return;
      return queryClient.fetchQuery({ ...projectCollaborationSummaryQueryOptions(projectId), staleTime: 0 }).then(() => queryClient.fetchInfiniteQuery(projectCommentsInfiniteQueryOptions(projectId))).then(() => {
        if (!isCurrent() || runRef.current !== run) return;
        setCollaborationOnly(true); setInitialDetailProbe(false);
      });
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || (reason instanceof Error && reason.name === "AbortError")) return;
      setInitialDetailProbe(false);
      accessFailure(reason, "collaboration-summary", undefined, true);
    });
    return () => { controller.abort(); void queryClient.cancelQueries({ queryKey: projectDataKeys.collaborationSummary(projectId), exact: true }); void queryClient.cancelQueries({ queryKey: projectDataKeys.comments(projectId), exact: true }); };
  }, [accessFailure, initialDetailProbe, isCurrent, projectId, queryClient, run, terminal]);
  useEffect(() => {
    for (const kind of collectionDenied) {
      discardAssetLedgerForResource(queryClient, projectId, kind);
      void queryClient.cancelQueries({ queryKey: projectDataKeys.assets(projectId, kind), exact: true }).then(() => {
        queryClient.removeQueries({ queryKey: projectDataKeys.assets(projectId, kind), exact: true });
      });
    }
  }, [collectionDenied, projectId, queryClient]);
  useEffect(() => {
    if (!collaborationUnavailable || terminal) return;
    void purgeProjectCollaborationData(queryClient, projectId);
  }, [collaborationOnly, collaborationUnavailable, projectId, queryClient, terminal]);
  useEffect(() => {
    if (!terminal || terminal.projectId !== projectId) return;
    manualOwnerRef.current?.controller.abort(); if (activeJobTimerRef.current) window.clearInterval(activeJobTimerRef.current); if (legacyTimerRef.current) window.clearTimeout(legacyTimerRef.current); for (const timer of syncDelayTimersRef.current) window.clearTimeout(timer); syncDelayTimersRef.current.clear(); activeJobTimerRef.current = undefined; legacyTimerRef.current = undefined;
    setIngest(null); setJobs([]); setAutohdrStatus(null); setCollaborationOnly(false); setCollaborationUnavailable(false); setIsSyncing(false); setIsSending(false); setOpenAssetId(null); setLightboxOrderIds(null); setCollectionDenied(new Set());
    void (terminal.scope === "principal" ? clearPrincipalProjectData(queryClient) : purgeProjectData(queryClient, projectId));
  }, [projectId, queryClient, terminal]);
  useEffect(() => {
    if (!isCurrent() || !manualReadyFor || manualReadyFor !== queryReadyFor || !canAdminBackend || !jobs.some(activeJob)) return;
    const refreshUntilTerminal = () => { void Promise.all([refreshJobs(), canViewEdited ? forceAssetsRead("edited") : Promise.resolve(undefined), forceDetailRead()]).catch(() => undefined); };
    activeJobTimerRef.current = window.setInterval(refreshUntilTerminal, 5_000);
    return () => { if (activeJobTimerRef.current) window.clearInterval(activeJobTimerRef.current); activeJobTimerRef.current = undefined; };
  }, [canAdminBackend, canViewEdited, forceAssetsRead, forceDetailRead, isCurrent, jobs, manualReadyFor, queryReadyFor, refreshJobs]);
  useEffect(() => {
    if (!isCurrent() || !manualReadyFor || manualReadyFor !== queryReadyFor || !canAdminBackend || !stageKeyForManual || (stageKeyForManual !== "raw_review" && stageKeyForManual !== "editing_autohdr") || jobs.some((job) => job.kind === "autohdr_api_send")) return;
    autohdrObservedRef.current = null; let mounted = true;
    const poll = async () => { try { const handoff = await refreshAutohdrStatus(); if (!mounted) return; if (handoff?.state === "started" && handoff.mappingState === "active") { const freshJobs = await refreshJobs(); if (!mounted) return; const fetchJob = freshJobs.find((job) => job.kind === "fetch_edited" && job.correlationId === `fetch_edited:${projectId}:${handoff.generation}`); const alreadyObserved = autohdrObservedRef.current?.handoffId === handoff.id && autohdrObservedRef.current?.jobId === fetchJob?.id; if (fetchJob && !alreadyObserved) { if (activeJob(fetchJob)) autohdrObservedRef.current = { handoffId: handoff.id, jobId: fetchJob.id }; else { if (canViewEdited) void forceAssetsRead("edited"); autohdrObservedRef.current = { handoffId: handoff.id, jobId: fetchJob.id }; } } } if (handoff && stageKeyForManual === "raw_review") void forceDetailRead(); const terminalState = handoff !== null && (handoff.state === "retired" || handoff.state === "failed"); const blocked = handoff?.state === "blocked" || handoff?.mappingState === "blocked_collision"; if (mounted && !terminalState && !blocked) legacyTimerRef.current = window.setTimeout(poll, 5_000); } catch { if (mounted) legacyTimerRef.current = window.setTimeout(poll, 5_000); } };
    void poll(); return () => { mounted = false; if (legacyTimerRef.current) window.clearTimeout(legacyTimerRef.current); legacyTimerRef.current = undefined; };
  }, [canAdminBackend, canViewEdited, forceAssetsRead, forceDetailRead, isCurrent, jobs, manualReadyFor, projectId, queryReadyFor, refreshAutohdrStatus, refreshJobs, stageKeyForManual]);

  async function syncDropbox() {
    const owner = manualOwnerRef.current; if (!owner || !isCurrent()) return; setIsSyncing(true);
    try {
      const response = await apiPost<DropboxSyncResponse, Record<string, never>>(`/api/projects/${encodeURIComponent(projectId)}/sync-dropbox`, {});
      for (let count = 0; count < 6; count += 1) {
        await new Promise<void>((resolve) => { const timer = window.setTimeout(() => { syncDelayTimersRef.current.delete(timer); resolve(); }, 2500); syncDelayTimersRef.current.add(timer); });
        if (!isCurrent()) return;
        const changed = new Map<string, ProjectDataResource>();
        const forceChanged = async (kind: CollectionKind) => {
          if (!canReadCollection(kind)) return;
          const key = projectDataKeys.assets(projectId, kind); const before = queryClient.getQueryData(key);
          const after = await forceAssetsRead(kind);
          if (after !== before) changed.set(JSON.stringify({ kind: "assets", collectionKind: kind }), { kind: "assets", collectionKind: kind });
        };
        await Promise.all([forceChanged(activeTab), refreshIngest(), canViewEdited ? forceChanged("edited") : Promise.resolve(), ...(canAdminBackend ? [refreshJobs(), refreshAutohdrStatus()] : [])]);
        if (changed.size) runtime.publish(createProjectDataInvalidationMessage(projectId, [...changed.values()]));
      }
      const queued = [response.raw, response.edited].filter((source) => "jobId" in source).length; const needsAttention = [response.raw, response.edited].some((source) => "blocked" in source || ("skipped" in source && source.skipped === "error")); toast(needsAttention ? "Dropbox check complete — some sources need attention." : queued ? `Dropbox check complete — ${queued} source${queued === 1 ? "" : "s"} queued.` : "Dropbox check complete.", needsAttention ? "error" : "success");
    }
    catch (reason) { if (!(reason instanceof Error && reason.name === "AbortError")) { terminateOnUnauthorized(reason); toast(reason instanceof Error ? reason.message : "Dropbox sync could not be started.", "error"); } } finally { if (isCurrent()) setIsSyncing(false); }
  }
  async function sendToAutoHdr() { if (!projectId || !canAdminBackend || !isCurrent()) return; setIsSending(true); try { const response = await apiPost<{ jobId: string }, Record<string, never>>(`/api/projects/${encodeURIComponent(projectId)}/send-to-autohdr`, {}); await Promise.all([refreshJobs(), invalidate([{ kind: "detail" }])]); toast(`Sending selected frames to AutoHDR (${response.jobId.slice(0, 8)}).`); } catch (reason) { terminateOnUnauthorized(reason); toast(reason instanceof Error ? reason.message : "The selected photos could not be sent to AutoHDR.", "error"); } finally { if (isCurrent()) setIsSending(false); } }
  async function retryAutoHdr(jobId: string) { if (!canAdminBackend || !isCurrent()) return; try { await apiPost<{ jobId: string }, Record<string, never>>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {}); await Promise.all([refreshJobs(), invalidate([{ kind: "detail" }])]); toast("Background job retry started."); } catch (reason) { terminateOnUnauthorized(reason); toast(reason instanceof Error ? reason.message : "Background job retry could not be started.", "error"); } }

  const workspaceReady = manualReadyFor === run && queryReadyFor === run;
  const runtimeTerminal = runtime.isProjectRemoved(projectId)
    ? { projectId, scope: runtime.principalTerminal ? "principal" as const : "project" as const, message: runtime.principalTerminal ? "Your session is no longer available." : "Project data is no longer available." }
    : null;
  const currentTerminal = terminal?.projectId === projectId ? terminal : runtimeTerminal;
  useEffect(() => {
    if (!runtimeTerminal || terminal?.projectId === projectId) return;
    setTerminal(runtimeTerminal);
  }, [projectId, runtimeTerminal, terminal]);
  const viewState = currentTerminal ? "unavailable" : collaborationOnly ? "collaboration-only" : workspaceReady ? "full-workspace" : collaborationUnavailable ? "collaboration-unavailable" : "loading";
  const consumeTerminalSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => { if ((viewState !== "collaboration-only" && viewState !== "collaboration-unavailable" && viewState !== "unavailable") || collaborationOpenSignal === undefined || collaborationOpenSignal === consumeTerminalSignalRef.current) return; consumeTerminalSignalRef.current = collaborationOpenSignal; onCollaborationOpenSignalConsumed?.(collaborationOpenSignal); }, [collaborationOpenSignal, onCollaborationOpenSignalConsumed, viewState]);
  if (!projectId || viewState === "unavailable") return <UnavailableProject message={currentTerminal?.message ?? "Project unavailable."} />;
  if (viewState === "collaboration-only") return <CollaborationOnlyView projectId={projectId} onAccessFailure={accessFailure} />;
  if (viewState === "collaboration-unavailable") return <CollaborationOnlyUnavailable />;
  if (initialDetailProbe) return <main className="page"><div className="empty"><span className="serif">Loading project.</span>Preparing the workspace.</div></main>;
  return <>
    <ProjectWorkspaceQueryOwner projectId={projectId} role={role ?? "photographer"} run={run} activeTab={activeTab} collectionDenied={collectionDenied} workspaceReady={workspaceReady} collaborationUnavailable={collaborationUnavailable} canViewEdited={canViewEdited} canAdminBackend={canAdminBackend} onDetailReady={(ownerRun, stageKey) => { if (ownerRun !== runRef.current) return; setStageKeyForManual(stageKey); startCompanionBatch(ownerRun); }} onDetailStage={(ownerRun, stageKey) => { if (ownerRun !== runRef.current) return; setStageKeyForManual(stageKey); }} onQueryReady={(ownerRun, defaultEdited) => { if (ownerRun !== runRef.current) return; setQueryReadyFor(ownerRun); if (defaultEdited && initialTabHandledRef.current !== ownerRun) { initialTabHandledRef.current = ownerRun; setActiveTab("edited"); } }} onAccessFailure={accessFailure} onCollectionDenied={(kind) => { setCollectionDenied((current) => current.has(kind) ? current : new Set(current).add(kind)); if (activeTab === kind) setActiveTab(kind === "raw" && canViewEdited ? "edited" : "raw"); }} activeTabChange={setActiveTab} openAssetId={openAssetId} setOpenAssetId={setOpenAssetId} lightboxOrderIds={lightboxOrderIds} setLightboxOrderIds={setLightboxOrderIds} ingest={ingest} jobs={jobs} autohdrStatus={autohdrStatus} isSyncing={isSyncing} isSending={isSending} onSyncDropbox={() => void syncDropbox()} onSendToAutoHdr={() => void sendToAutoHdr()} onRetryAutoHdr={(jobId) => void retryAutoHdr(jobId)} onUploadComplete={onUploadComplete} onDocumentsChanged={onDocumentsChanged} onLinksChanged={onLinksChanged} onInvalidate={invalidate} onRefreshDetail={forceDetailRead} canReadCollection={canReadCollection} />
    {viewState === "full-workspace" && (collaborationUnavailable ? <CollaborationOnlyUnavailable /> : <ProjectCollaborationPanel projectId={projectId} openSignal={collaborationOpenSignal} onOpenSignalConsumed={onCollaborationOpenSignalConsumed} onAccessFailure={accessFailure} />)}
  </>;
}

// #110 AC3: a single always-mounted viewport sibling, so a toast raised from ANY of
// `ProjectWorkspaceView`'s five view states (including `unavailable`) has somewhere to render —
// previously only `full-workspace` and the `UnavailableProject` states had one.
export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  return <><ProjectWorkspaceView {...props} /><ToastViewport /></>;
}

function CollaborationOnlyView({ projectId, onAccessFailure }: { projectId: string; onAccessFailure: (error: unknown, resource: AccessFailureResource, kind?: CollectionKind, initial?: boolean) => void }) {
  const summary = useProjectCollaborationSummaryQuery(projectId, true);
  const commentsQuery = useProjectCommentsCacheQuery(projectId);
  const { stages, presentationStageKey } = useStages();
  useEffect(() => { if (summary.error) onAccessFailure(summary.error, "collaboration-summary"); }, [onAccessFailure, summary.error]);
  if (summary.error) return <CollaborationOnlyUnavailable />;
  const street = summary.data?.project.street ?? commentsQuery.data?.pages[0]?.project.street ?? "Project collaboration";
  const stage = summary.data && stages.find((item) => item.key === presentationStageKey(summary.data.project.stageKey));
  return <main className="page grid gap-[var(--space-5)]" data-testid="project-collaboration-only">
    <div className="pagehead"><div><Eyebrow>Collaboration</Eyebrow><h1 className="serif">{street}</h1></div><InternalLink className={buttonClasses("secondary")} to="/">Back to dashboard</InternalLink></div>
    {summary.isPending && !summary.data && <EmptyState role="status" title="Loading collaboration.">Preparing the project summary.</EmptyState>}
    {summary.data && <section className="grid gap-[var(--space-3)] p-[var(--space-5)] bg-card [border-style:solid] border-[length:var(--border-width-hair)] border-border" aria-labelledby="collaboration-summary-heading"><Eyebrow>Read-only summary</Eyebrow><h2 className="serif [font:var(--type-h3)]" id="collaboration-summary-heading">Project overview</h2><div className="grid gap-[var(--space-3)]"><div className="kv"><span className="k">Stage</span><span className="vv">{stage?.label ?? summary.data.project.stageKey}</span></div><div className="kv"><span className="k">Deadline</span><span className="vv">Not scheduled</span></div><div className="kv"><span className="k">Next reminder</span><span className="vv">None</span></div></div><div className="grid gap-[var(--space-3)] grid-cols-2 max-[721px]:grid-cols-1 pt-[var(--space-3)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border"><div><Eyebrow>Photographers</Eyebrow>{summary.data.members.filter((member) => member.roleOnProject === "photographer").map((member) => <div className="py-[5px] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" key={member.id}>{member.name}{!member.active && <em className="ms-[6px] not-italic text-signal-caution-text">Inactive</em>}</div>)}</div><div><Eyebrow>Editors</Eyebrow>{summary.data.members.filter((member) => member.roleOnProject === "editor").map((member) => <div className="py-[5px] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" key={member.id}>{member.name}{!member.active && <em className="ms-[6px] not-italic text-signal-caution-text">Inactive</em>}</div>)}</div></div></section>}
    <ProjectCollaborationPanel projectId={projectId} mode="standalone" onAccessFailure={onAccessFailure} />
  </main>;
}

function CollaborationOnlyUnavailable() {
  return <main className="page grid gap-[var(--space-5)]" data-testid="project-collaboration-only"><div className="pagehead"><div><Eyebrow>Collaboration</Eyebrow><h1 className="serif">Project collaboration</h1></div><InternalLink className={buttonClasses("secondary")} to="/">Back to dashboard</InternalLink></div><section className="grid content-start p-[var(--space-5)] bg-card [border-style:solid] border-[length:var(--border-width-hair)] border-border" aria-label="Project collaboration"><EmptyState tone="error" title="Collaboration unavailable.">This project discussion is no longer available.</EmptyState></section></main>;
}

function UnavailableProject({ message }: { message: string }) { return <main className="page"><div className="pagehead"><h1 className="serif">Project workspace</h1><InternalLink className={buttonClasses("secondary")} to="/">Back to dashboard</InternalLink></div><div className="empty" role="alert"><span className="serif">Project unavailable.</span>{message}</div></main>; }

type QueryOwnerProps = {
  projectId: string; role: Role; run: number; activeTab: CollectionKind; collectionDenied: Set<CollectionKind>; workspaceReady: boolean; collaborationUnavailable: boolean; canViewEdited: boolean; canAdminBackend: boolean;
  onDetailReady: (run: number, stageKey: ProjectStageKey) => void; onDetailStage: (run: number, stageKey: ProjectStageKey) => void; onQueryReady: (run: number, defaultEdited: boolean) => void; onAccessFailure: (error: unknown, resource: AccessFailureResource, kind?: CollectionKind, initial?: boolean) => void; onCollectionDenied: (kind: CollectionKind) => void; activeTabChange: (kind: CollectionKind) => void;
  openAssetId: string | null; setOpenAssetId: (id: string | null) => void; lightboxOrderIds: string[] | null; setLightboxOrderIds: (ids: string[] | null) => void; ingest: IngestStatus | null; jobs: Job[]; autohdrStatus: AutoHdrStatusResponse["handoff"]; isSyncing: boolean; isSending: boolean; onSyncDropbox: () => void; onSendToAutoHdr: () => void; onRetryAutoHdr: (jobId: string) => void; onUploadComplete: (kind: "raw" | "edited") => Promise<void>; onDocumentsChanged: (kind: "floorplan" | "copy") => Promise<void>; onLinksChanged: () => Promise<void>; onInvalidate: (resources: ProjectDataResource[]) => Promise<void>; onRefreshDetail: () => Promise<ProjectDetail | undefined>; canReadCollection: (kind: CollectionKind) => boolean;
};

function ProjectWorkspaceQueryOwner(props: QueryOwnerProps) {
  const detail = useProjectDetailQuery(props.projectId, true, false, props.role);
  const collaborationSummary = useProjectCollaborationSummaryQuery(props.projectId, Boolean(detail.data) && !props.collaborationUnavailable, false);
  const detailReadyReported = useRef<number | null>(null);
  const onDetailStageRef = useRef(props.onDetailStage);
  onDetailStageRef.current = props.onDetailStage;
  const detailClassification = detail.error ? classifyProjectAccessError(detail.error, "detail") : null;
  const collaborationClassification = collaborationSummary.error ? classifyProjectAccessError(collaborationSummary.error, "collaboration-summary") : null;
  useEffect(() => { if (!detail.isSuccess || !detail.data || detailReadyReported.current === props.run) return; detailReadyReported.current = props.run; props.onDetailReady(props.run, detail.data.stageKey); }, [detail.data, detail.isSuccess, props]);
  useEffect(() => { if (!detail.isSuccess || !detail.data) return; onDetailStageRef.current(props.run, detail.data.stageKey); }, [detail.data?.stageKey, detail.isSuccess, props.run]);
  useEffect(() => { if (detail.error) props.onAccessFailure(detail.error, "detail", undefined, !detail.data); }, [detail.data, detail.error, props]);
  useEffect(() => { if (collaborationSummary.error) props.onAccessFailure(collaborationSummary.error, "collaboration-summary", undefined, !collaborationSummary.data); }, [collaborationSummary.data, collaborationSummary.error, props]);
  const initialCollaborationProbe = !detail.data && detail.error instanceof ApiError && detail.error.status === 403;
  if ((detailClassification?.scope === "principal" || detailClassification?.scope === "project") && !initialCollaborationProbe) return <UnavailableProject message={detail.error instanceof Error ? detail.error.message : "Project unavailable."} />;
  if (collaborationClassification?.scope === "principal" || collaborationClassification?.scope === "project") return <UnavailableProject message={collaborationSummary.error instanceof Error ? collaborationSummary.error.message : "Project unavailable."} />;
  if (!detail.data) return <main className="page"><div className="empty">{detail.error && !initialCollaborationProbe ? <><span className="serif">Project data could not be loaded.</span><div role="alert">{detail.error.message}</div><button className={buttonClasses()} type="button" onClick={() => void detail.refetch()}>Retry</button></> : <><span className="serif">Loading project.</span>Preparing the workspace.</>}</div></main>;
  if (props.collectionDenied.size > 0 && props.collectionDenied.has(props.activeTab)) return <WorkspaceBody detail={detail.data} detailReady={detail.isSuccess} assets={[]} rawAssets={[]} assetsPending={false} {...props} />;
  return <ActiveAssetsObserver detail={detail.data} detailReady={detail.isSuccess} {...props} />;
}

type ActiveAssetsProps = QueryOwnerProps & { detail: ProjectDetail; detailReady: boolean };
function ActiveAssetsObserver(props: ActiveAssetsProps) {
  const assetsQuery = useProjectAssetsQuery(props.projectId, props.activeTab, props.detailReady && props.canReadCollection(props.activeTab), false, props.role);
  const bootstrapReported = useRef<number | null>(null);
  const classification = assetsQuery.error ? classifyProjectAccessError(assetsQuery.error, "assets", props.activeTab) : null;
  useEffect(() => { if (props.activeTab === "raw" && (assetsQuery.isSuccess || Boolean(assetsQuery.error)) && bootstrapReported.current !== props.run) { bootstrapReported.current = props.run; props.onQueryReady(props.run, props.canViewEdited && ["editing_autohdr", "edited_review", "delivered"].includes(props.detail.stageKey)); } }, [assetsQuery.error, assetsQuery.isSuccess, props]);
  useEffect(() => { if (!assetsQuery.error) return; if (classification?.scope === "collection") props.onCollectionDenied(props.activeTab); else props.onAccessFailure(assetsQuery.error, "assets", props.activeTab, !assetsQuery.data); }, [assetsQuery.error, assetsQuery.data, classification, props]);
  const assets = projectAssetsForRender(assetsQuery.data, assetsQuery.error, props.activeTab);
  if (classification?.scope === "principal" || classification?.scope === "project") return <UnavailableProject message={assetsQuery.error instanceof Error ? assetsQuery.error.message : "Project unavailable."} />;
  if (!props.workspaceReady) return <main className="page"><div className="empty"><span className="serif">Loading project.</span>Preparing the workspace.</div></main>;
  if (props.activeTab !== "raw") return <NonRawWorkspaceBody {...props} assets={assets} assetsPending={assetsQuery.isPending && !assetsQuery.data} />;
  return <WorkspaceBody {...props} assets={assets} rawAssets={assets} assetsPending={assetsQuery.isPending && !assetsQuery.data} />;
}
function NonRawWorkspaceBody(props: ActiveAssetsProps & { assets: WorkspaceAsset[]; assetsPending: boolean }) {
  const raw = usePassiveRawAssetsQuery(props.projectId, true, props.role);
  const classification = raw.error ? classifyProjectAccessError(raw.error, "assets", "raw") : null;
  useEffect(() => { if (!raw.error) return; if (classification?.scope === "collection") props.onCollectionDenied("raw"); else props.onAccessFailure(raw.error, "assets", "raw", !raw.data); }, [classification, props, raw.data, raw.error]);
  const rawAssets = projectAssetsForRender(raw.data, raw.error, "raw");
  if (classification?.scope === "principal" || classification?.scope === "project") return <UnavailableProject message={raw.error instanceof Error ? raw.error.message : "Project unavailable."} />;
  return <WorkspaceBody {...props} rawAssets={rawAssets} />;
}

type WorkspaceBodyProps = ActiveAssetsProps & { assets: WorkspaceAsset[]; rawAssets: WorkspaceAsset[]; assetsPending: boolean };
function WorkspaceBody(props: WorkspaceBodyProps) {
  const { can } = useCapabilities(); const queryClient = useQueryClient(); const runtime = getProjectQueryRuntime(queryClient);
  const { stages } = useStages();
  const terminateOnUnauthorized = useProjectAccessTermination();
  const { detail: project, assets, rawAssets, activeTab, openAssetId, setOpenAssetId, lightboxOrderIds, setLightboxOrderIds } = props;
  const isEdited = activeTab === "edited"; const canUpload = can("uploadRaw"), canSelect = can("selectForEditing"), canEdit = can("editProject"), canManageCollections = can("editProject") || can("manageExtras") || can("uploadExtras"), canDeleteAssets = can("adminBackend");
  const canReview = isEdited ? can("reviewEdited") : can("selectForEditing"); const canRecommend = activeTab === "raw" && can("recommendRaw"); const canAnnotate = activeTab === "raw" ? can("annotateRaw") : isEdited && can("annotateEdited");
  const availableTabs = (can("viewEdited") ? ["raw", "edited", "video", "floorplan", "copy"] : ["raw"]).filter((kind) => !props.collectionDenied.has(kind as CollectionKind)) as CollectionKind[];
  const rawCollection = project.collections.find((collection) => collection.kind === "raw"); const selectionCount = rawAssets.filter((asset) => asset.selected).length;
  const [stageMovePending, setStageMovePending] = useState(false);
  const [stageMoveDisabledReason, setStageMoveDisabledReason] = useState<string | null>(null);
  const restoreStageFocusRef = useRef(false);
  useLayoutEffect(() => {
    if (!restoreStageFocusRef.current || stageMovePending) return;
    restoreStageFocusRef.current = false;
    const control = document.querySelector<HTMLButtonElement>(`[data-focus-key="rail-stage:${project.id}"]`);
    if (control && !control.disabled) control.focus();
  }, [project.id, project.stageKey, stageMovePending]);
  const autoHdrApiJobs = props.jobs.filter((job) => job.kind === "autohdr_api_send"); const latestAutoHdrApiJob = autoHdrApiJobs[0]; const autoHdrApiSendActive = autoHdrApiJobs.some(activeJob); const usesSendOnlyAutoHdrApi = autoHdrApiJobs.length > 0; const hasRawFolder = project.editedUploadAvailable ?? Boolean(project.rawFolderPath || project.rawFolderLink);
  const autohdrTerminal = props.autohdrStatus?.state === "retired" || props.autohdrStatus?.state === "failed"; const autohdrBlocked = !autohdrTerminal && (props.autohdrStatus?.state === "blocked" || props.autohdrStatus?.mappingState === "blocked_collision");
  const autohdrStatusLabel = usesSendOnlyAutoHdrApi ? latestAutoHdrApiJob?.status === "done" ? "Sent to AutoHDR" : latestAutoHdrApiJob?.status === "failed" || latestAutoHdrApiJob?.status === "stuck" ? "AutoHDR send needs attention" : "Sending selected photos to AutoHDR" : autohdrBlocked ? "Blocked — staff resolution needed" : props.isSyncing ? "Checking Dropbox…" : props.autohdrStatus?.mappingState === "active" ? "Fetched" : props.autohdrStatus?.state === "started" ? "Waiting for AutoHDR output" : "Not yet sent to autoHDR";
  const autohdrMessage = usesSendOnlyAutoHdrApi ? "This integration is send-only. Quincy Portal does not fetch or retrieve the edited photos." : autohdrBlocked ? (props.autohdrStatus?.diagnostic ?? "AutoHDR output needs staff resolution before it can be fetched.") : "Pull finished edits from autoHDR's 04-FINAL-Photos into this collection.";
  const updateReview = useCallback(async (assetId: string, patch: ReviewPatch) => { const before = assets.find((asset) => asset.id === assetId); if (!before) return; let mutation: Awaited<ReturnType<typeof beginAssetOptimisticMutation>> | undefined; try { mutation = await beginAssetOptimisticMutation(queryClient, project.id, activeTab, assetId, patch); await apiPost(`/api/assets/${encodeURIComponent(assetId)}/review`, patch); await mutation.commit(); } catch (reason) { await mutation?.fail(); terminateOnUnauthorized(reason); toast(reason instanceof Error ? reason.message : "The review change could not be saved.", "error"); } }, [activeTab, assets, project.id, queryClient, terminateOnUnauthorized]);
  const updateSelection = useCallback(async (assetId: string, selected: boolean) => { const before = rawAssets.find((asset) => asset.id === assetId); if (!before) return; let mutation: Awaited<ReturnType<typeof beginAssetOptimisticMutation>> | undefined; try { mutation = await beginAssetOptimisticMutation(queryClient, project.id, "raw", assetId, { selected }); if (selected) await apiPost(`/api/assets/${encodeURIComponent(assetId)}/select`, {}); else await apiDelete<void>(`/api/assets/${encodeURIComponent(assetId)}/select`); await mutation.commit(); } catch (reason) { await mutation?.fail(); terminateOnUnauthorized(reason); toast(reason instanceof Error ? reason.message : "The selection could not be saved.", "error"); } }, [project.id, queryClient, rawAssets, terminateOnUnauthorized]);
  const updateCover = useCallback(async (assetId: string | null) => { try { await apiPost(`/api/projects/${encodeURIComponent(project.id)}/cover`, { assetId }); await props.onInvalidate([{ kind: "detail" }]); toast(assetId === null ? "Cover cleared — using the first RAW frame." : "Cover updated."); } catch (reason) { terminateOnUnauthorized(reason); toast(reason instanceof Error ? reason.message : "The project cover could not be updated.", "error"); } }, [project.id, props, terminateOnUnauthorized]);
  const moveStage = useCallback(async (targetStageKey: ProjectStageKey) => {
    if (stageMovePending || !can("moveProjectStage") || project.archivedAt || !project.contractEnabled) return;
    restoreStageFocusRef.current = true;
    setStageMovePending(true);
    setStageMoveDisabledReason(null);
    const request: MoveProjectStageRequest = {
      expected: { stageKey: project.stageKey, boardRevision: project.boardRevision },
      targetStageKey,
      placement: { kind: "append" },
    };
    try {
      const response = await submitStageMoveWithConfirmation(request, (body) => apiPost<MoveProjectStageResponse, MoveProjectStageRequest>(`/api/projects/${encodeURIComponent(project.id)}/stage`, body), { confirmationPolicy: "stage-move" });
      if (!response) {
        await props.onRefreshDetail().catch(() => undefined);
        return;
      }
      if (response.changed) {
        await invalidateProjectSurfaces(queryClient, {
          projectId: project.id,
          resources: [{ kind: "detail" }, { kind: "activity" }],
          dashboard: true,
          calendar: true,
        });
      }
      try {
        await props.onRefreshDetail();
      } catch (refreshError) {
        setStageMoveDisabledReason("The Stage move was saved, but the latest project could not be loaded. Refresh to continue.");
        toast(refreshError instanceof Error ? refreshError.message : "The latest project could not be loaded.", "error");
        return;
      }
      const label = stages.find((stage) => stage.key === targetStageKey)?.label ?? targetStageKey;
      toast(response.changed ? `Moved to ${label}.` : `Already in ${label}.`);
    } catch (reason) {
      const code = reason instanceof ApiError && reason.details && typeof reason.details === "object" ? (reason.details as { code?: unknown }).code : undefined;
      if (reason instanceof ApiError && reason.status === 401) {
        terminateOnUnauthorized(reason);
        return;
      } else if (reason instanceof ApiError && reason.status === 503 && code === "board_contract_disabled") {
        setStageMoveDisabledReason("Stage movement is temporarily unavailable while the Board contract is disabled.");
      } else if (reason instanceof ApiError && reason.status === 503 && code === "board_schema_maintenance") {
        setStageMoveDisabledReason("Stage movement is temporarily unavailable while the Board is being updated.");
      } else if (reason instanceof ApiError && reason.status === 409 && code === "project_stage_conflict") {
        await props.onRefreshDetail().catch(() => undefined);
        toast("The project changed elsewhere; the Stage was refreshed.", "error");
      } else if (reason instanceof ApiError && reason.status === 403) {
        await props.onRefreshDetail().catch(() => undefined);
        toast(reason.message, "error");
      } else {
        toast(reason instanceof Error ? reason.message : "The Stage could not be updated.", "error");
      }
    } finally {
      setStageMovePending(false);
    }
  }, [can, project, props, stageMovePending, stages, terminateOnUnauthorized]);
  const deleteOne = useCallback(async (assetId: string) => { try { const response = await apiDelete<AssetDeleteResponse>(`/api/assets/${encodeURIComponent(assetId)}`); if (deletedAssetClosesLightbox(openAssetId, response.deletedAssetIds)) { setOpenAssetId(null); setLightboxOrderIds(null); } const resources: ProjectDataResource[] = [{ kind: "assets", collectionKind: activeTab }, { kind: "detail" }]; if (activeTab === "raw") resources.push({ kind: "assets", collectionKind: "edited" }); await props.onInvalidate(resources); const warning = response.dropboxOutcome === "failed" || response.dropboxOutcome === "claimLost"; toast(warning ? "Asset deleted, but Dropbox cleanup needs attention." : "Asset deleted.", warning ? "error" : "success"); } catch (reason) { terminateOnUnauthorized(reason); toast(reason instanceof Error ? reason.message : "The asset could not be deleted.", "error"); throw reason; } }, [activeTab, openAssetId, props, setLightboxOrderIds, setOpenAssetId, terminateOnUnauthorized]);
  const deleteMany = useCallback(async (assetIds: string[]) => { const results = await Promise.allSettled(assetIds.map((assetId) => apiDelete<AssetDeleteResponse>(`/api/assets/${encodeURIComponent(assetId)}`))); const accessFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected" && result.reason instanceof ApiError && (result.reason.status === 401 || result.reason.status === 403 || result.reason.status === 404)); if (accessFailure) terminateOnUnauthorized(accessFailure.reason); const { succeededIds, failedIds, dropboxCleanupWarnings } = computeBulkDeleteOutcome(assetIds, results); if (deletedAssetClosesLightbox(openAssetId, succeededIds)) { setOpenAssetId(null); setLightboxOrderIds(null); } const resources: ProjectDataResource[] = [{ kind: "assets", collectionKind: activeTab }, { kind: "detail" }]; if (activeTab === "raw") resources.push({ kind: "assets", collectionKind: "edited" }); await props.onInvalidate(resources); if (failedIds.length) toast(`${failedIds.length} asset${failedIds.length === 1 ? "" : "s"} could not be deleted.`, "error"); else if (dropboxCleanupWarnings) toast(`Deleted, but Dropbox cleanup needs attention for ${dropboxCleanupWarnings} assets.`, "error"); else toast("Selected assets deleted."); return { succeededIds, failedIds }; }, [activeTab, openAssetId, props, setLightboxOrderIds, setOpenAssetId, terminateOnUnauthorized]);
  const downloadSelection = useCallback(async (assetIds: string[]) => {
    try {
      const response = await apiPost<{ downloadUrl: string }, { assetIds: string[] }>(`/api/projects/${encodeURIComponent(project.id)}/download-selection`, { assetIds });
      const link = document.createElement("a"); link.href = response.downloadUrl; link.download = ""; document.body.append(link); link.click(); link.remove();
    } catch (reason) {
      terminateOnUnauthorized(reason);
      toast(reason instanceof Error ? reason.message : "The selected assets could not be downloaded.", "error");
      throw reason;
    }
  }, [project.id, terminateOnUnauthorized]);
  useEffect(() => { if (openAssetId && !assets.some((asset) => asset.id === openAssetId)) { setOpenAssetId(null); setLightboxOrderIds(null); } }, [assets, openAssetId, setLightboxOrderIds, setOpenAssetId]);
  const lightboxAssets = lightboxOrderIds ? lightboxOrderIds.map((id) => assets.find((asset) => asset.id === id)).filter((asset): asset is WorkspaceAsset => Boolean(asset)) : assets;
  return <><main className="work" data-testid="project-workspace">
    <ProjectHeader project={project} activeTab={activeTab} availableTabs={availableTabs} canUpload={canUpload} canAdminBackend={props.canAdminBackend} canEdit={canEdit} hasRawFolder={hasRawFolder} autohdrBlocked={autohdrBlocked} isSyncing={props.isSyncing} onSyncDropbox={props.onSyncDropbox} onActiveTabChange={props.activeTabChange} onStageMove={(targetStageKey) => { void moveStage(targetStageKey); }} stageMovePending={stageMovePending} stageMoveDisabledReason={stageMoveDisabledReason} />
    <section className="workmain" data-testid="workspace-main"><div className="wsbar"><span className="ey">{activeTab === "raw" ? `RAW capture · ${rawCollection?.receivedCount ?? 0} received` : `${collectionLabel(activeTab)} collection`}</span><div className="grow" /></div>{project.editorFolderAttention && <EditorFolderAttentionNotice attention={project.editorFolderAttention} />}{props.ingest?.mismatch && <div className="ingest-warning" role="alert"><strong>Capture count needs attention.</strong> Expected {props.ingest.expectedCount}, received {props.ingest.receivedCount}.</div>}{activeTab === "raw" || activeTab === "edited" ? <><div className="workspace-intro"><div><div className="ey">{activeTab === "raw" ? "Capture QA" : "Edited QA"}</div><h1 className="serif">{activeTab === "raw" ? "RAW frames" : "Edited frames"}</h1></div><div className="muted">{activeTab === "raw" ? "Ratings from XMP are shown at ingest. Select the strongest frames for editing." : "Review delivered edits before they move to client delivery."}</div></div>{props.canAdminBackend && activeTab === "raw" && canSelect && <div className="hdr" data-testid="autohdr-handoff"><div className="grow"><strong>AutoHDR hand-off</strong><div className="muted">{selectionCount} selected RAW frame{selectionCount === 1 ? "" : "s"} will be sent for editing.</div></div><div className="row gap2"><button className={buttonClasses("secondary")} type="button" disabled={selectionCount === 0} onClick={() => { const link = document.createElement("a"); link.href = `/api/projects/${encodeURIComponent(project.id)}/selected-raw.zip`; link.download = ""; document.body.append(link); link.click(); link.remove(); }}>{`Download ${selectionCount} selected (zip)`}</button><button className={buttonClasses()} type="button" disabled={selectionCount === 0 || props.isSending || autoHdrApiSendActive} onClick={props.onSendToAutoHdr}>{props.isSending || autoHdrApiSendActive ? "Sending to AutoHDR…" : `Send ${selectionCount} selected to AutoHDR`}</button></div></div>}{props.canAdminBackend && activeTab === "edited" && <div className="hdr" role="status"><div className="grow"><strong>AutoHDR status</strong><div className="muted"><span>{autohdrStatusLabel}</span></div><div className="muted">{autohdrMessage}</div></div></div>}{activeTab === "raw" && canUpload && <div className="workgrid"><UploadDropzone projectId={project.id} collection="raw" onComplete={() => props.onUploadComplete("raw")} onToast={toast} /></div>}{activeTab === "edited" && can("uploadEdited") && <div className="workgrid">{hasRawFolder ? <UploadDropzone projectId={project.id} collection="edited" onComplete={() => props.onUploadComplete("edited")} onToast={toast} /> : <div className="empty" role="status"><span className="serif">No Dropbox RAW folder for this shoot.</span>Edited uploads are published to Dropbox before they appear here.</div>}</div>}{props.assetsPending ? <div className="empty" role="status" data-testid="collection-loading"><span className="serif">Loading collection.</span>Reading this collection's assets.</div> : <PhotoGrid key={activeTab} assets={assets} showSections={activeTab === "raw" || activeTab === "edited"} canReview={canReview} canRecommend={canRecommend} canSelect={activeTab === "raw" && canSelect} canSetCover={canEdit && (activeTab === "raw" || activeTab === "edited")} canDelete={canDeleteAssets} canDownloadSelection={activeTab === "raw" ? can("selectForEditing") : can("downloadFinal")} coverAssetId={project.effectiveCoverAssetId} storedCoverAssetId={project.coverAssetId} onSetCover={updateCover} onOpen={(asset, orderedAssets) => { setLightboxOrderIds(orderedAssets.map((item) => item.id)); setOpenAssetId(asset.id); }} onReview={updateReview} onSelection={updateSelection} onDelete={deleteOne} onBulkDelete={deleteMany} onDownloadSelection={downloadSelection} />}</> : <CollectionPanel projectId={project.id} collection={activeTab as "video" | "floorplan" | "copy"} assets={assets} canManage={canManageCollections} canDelete={canDeleteAssets} canApprove={can("reviewEdited") && props.role !== "external_editor"} onReview={updateReview} onDelete={deleteOne} onLinksChanged={props.onLinksChanged} onDocumentsChanged={props.onDocumentsChanged} onToast={toast} />}{props.canAdminBackend && props.jobs.length > 0 && <div className="workgrid"><section className="hdr" style={{ alignItems: "flex-start", flexDirection: "column" }}><div><strong>Background jobs</strong><div className="muted">Recent AutoHDR sends, fetches, Editor folder passes, and manual-upload publishes for this project.</div></div>{props.jobs.map((job) => <div className="kv" style={{ width: "100%" }} key={job.id}><span className="k">{new Date(job.createdAt).toLocaleString("en-AU")}</span><span className="vv"><span className="k">{job.kind === "autohdr_api_send" ? "API send" : job.kind === "fetch_edited" ? "Fetch" : job.kind === "autohdr_scaffold" ? "Scaffold" : job.kind === "editor_reconcile" ? "Editor folder" : job.kind === "editor_sync" ? "Editor sync" : job.kind === "manual_edited_publish" || job.kind === "manual_raw_publish" ? "Manual upload" : "Send"}</span>{" "}<span className={`statetag st-${job.status}`}>{job.status}</span>{job.error ? ` ${job.error}` : ""}{job.kind !== "autohdr_api_send" && (job.status === "stuck" || job.status === "failed") && <button className="chip" style={{ marginLeft: 8 }} type="button" onClick={() => props.onRetryAutoHdr(job.id)}>Retry</button>}</span></div>)}</section></div>}</section>
    {openAssetId && lightboxAssets.some((asset) => asset.id === openAssetId) && <Lightbox assets={lightboxAssets} rawAssets={rawAssets} initialAssetId={openAssetId} collectionKind={activeTab === "edited" ? "edited" : "raw"} canReview={canReview} canRecommend={canRecommend} canAnnotate={canAnnotate} onClose={() => { setOpenAssetId(null); setLightboxOrderIds(null); }} onReview={updateReview} onToast={toast} />}
  </main></>;
}
