import { useCallback, useEffect, useRef, useState } from "react";
import { type ProjectStageKey, useStages } from "../lib/stages";
import { StatusBadge } from "../components/atoms";
import { Lightbox } from "../components/Lightbox";
import { PhotoGrid, type Review, type ReviewPatch, type WorkspaceAsset } from "../components/PhotoGrid";
import { UploadDropzone } from "../components/UploadDropzone";
import { CollectionPanel } from "../components/CollectionPanel";
import { ApiError, apiDelete, apiGet, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { InternalLink } from "../components/InternalLink";
import { ProjectCollaborationPanel, type CommentResponse } from "../components/ProjectCollaborationPanel";

type Collection = { id: string; kind: "raw" | "edited" | "video" | "floorplan" | "copy"; status: string; expectedCount: number | null; receivedCount: number };
type Member = { id: string; userId: string; roleOnProject: "photographer" | "editor"; name: string; email: string };
type Project = { id: string; street: string; suburb: string | null; postcode: string | null; agencyName: string | null; agentName: string | null; shootDate: string | null; stageKey: ProjectStageKey; rawFolderPath: string | null; rawFolderLink: string | null; coverAssetId: string | null; effectiveCoverAssetId: string | null };
type ProjectResponse = Project & { collections: Collection[]; members: Member[] };
type AssetsResponse = { assets: WorkspaceAsset[] };
type DownloadSelectionResponse = { downloadUrl: string };
type AssetDeleteResponse = { ok: boolean; deletedAssetIds: string[]; deletedObjects: number; dropboxDeleted: boolean; dropboxOutcome?: "removed" | "alreadyGone" | "claimLost" | "failed"; dropboxReason?: string };
type IngestStatus = { expectedCount: number | null; receivedCount: number; mismatch: boolean };
type Job = { id: string; kind: "autohdr" | "fetch_edited" | "autohdr_scaffold" | "manual_edited_publish"; status: "queued" | "running" | "done" | "failed" | "stuck"; error: string | null; correlationId: string | null; createdAt: string; updatedAt: string };
type JobsResponse = { jobs: Job[] };
type DropboxSyncResponse = {
  raw: { jobId: string } | { skipped: "no_raw_folder" | "not_permitted" | "error"; message?: string };
  edited: { jobId: string } | { skipped: "not_ready" | "not_admin" | "error"; message?: string } | { blocked: { code: string; message: string } };
};
interface AutoHdrStatusResponse {
  handoff: {
    id: string;
    generation: number;
    state: "starting" | "started" | "blocked" | "retired" | "failed";
    mappingState: "pending_discovery" | "active" | "blocked_collision" | "retired";
    finalPath: string | null;
    diagnostic: string | null;
  } | null;
}
type Toast = { id: number; message: string; tone: "success" | "error" };

function date(value: string | null) { return value ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)) : "Shoot date pending"; }
function collectionLabel(value: string) { return value === "raw" ? "RAW" : value.charAt(0).toUpperCase() + value.slice(1); }
function emptyReview(): Review { return { stars: null, colorLabel: null, decision: null, recommended: false }; }
function activeJob(job: Job) { return job.status === "queued" || job.status === "running"; }

/** Post-delete refreshes are independent requests: an unrelated tab refresh may abort one. */
export async function refreshAfterAssetDelete(refreshAssets: () => Promise<unknown>, refreshProject: () => Promise<unknown>): Promise<void> {
  let refreshFailure: unknown;
  await refreshAssets().catch((reason: unknown) => { if (!(reason instanceof Error && reason.name === "AbortError")) refreshFailure ??= reason; });
  await refreshProject().catch((reason: unknown) => { if (!(reason instanceof Error && reason.name === "AbortError")) refreshFailure ??= reason; });
  if (refreshFailure) throw refreshFailure;
}

export function deletedAssetClosesLightbox(openAssetId: string | null, deletedAssetIds: string[]): boolean {
  return openAssetId !== null && deletedAssetIds.includes(openAssetId);
}

type AssetDeleteResult = { deletedAssetIds: string[]; dropboxOutcome?: "removed" | "alreadyGone" | "claimLost" | "failed" };

/** Pure outcome computation for a bulk delete, kept separate from the component so a rejected
 * request can be tested independently of the network/toast/refresh side effects around it. */
export function computeBulkDeleteOutcome(assetIds: string[], results: PromiseSettledResult<AssetDeleteResult>[]) {
  // Only a FULFILLED result's own server-confirmed ids count as succeeded — a rejected request's
  // originally-requested id must land in failedIds, not be silently treated as successful.
  const succeededIds = results.flatMap((result) => result.status === "fulfilled" ? result.value.deletedAssetIds : []);
  const succeededSet = new Set(succeededIds);
  const failedIds = assetIds.filter((id) => !succeededSet.has(id));
  const dropboxCleanupWarnings = results.filter((result) =>
    result.status === "fulfilled" && (result.value.dropboxOutcome === "failed" || result.value.dropboxOutcome === "claimLost"),
  ).length;
  return { succeededIds: [...succeededSet], failedIds, dropboxCleanupWarnings };
}

export function ProjectWorkspace({ projectId, notice, onNoticeShown, collaborationOpenSignal, onCollaborationOpenSignalConsumed }: { projectId: string; notice?: string | null; onNoticeShown?: () => void; collaborationOpenSignal?: number; onCollaborationOpenSignalConsumed?: (signal: number) => void }) {
  const { can } = useCapabilities();
  const { presentationStageKey, stages } = useStages();
  const canAdminBackend = can("adminBackend");
  const canViewEdited = can("viewEdited");
  const [data, setData] = useState<ProjectResponse | null>(null);
  const [assets, setAssets] = useState<WorkspaceAsset[]>([]);
  const [rawAssets, setRawAssets] = useState<WorkspaceAsset[]>([]);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [autohdrStatus, setAutohdrStatus] = useState<AutoHdrStatusResponse["handoff"]>(null);
  const [activeTab, setActiveTab] = useState<Collection["kind"]>("raw");
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  // Snapshot of the grid's displayed order (Captures then alphabetical sections) at open time — ids only,
  // so the lightbox still reads live review/selection state from `assets`.
  const [lightboxOrderIds, setLightboxOrderIds] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewState, setViewState] = useState<"loading" | "full-workspace" | "collaboration-only" | "unavailable">("loading");
  const [fallbackComments, setFallbackComments] = useState<CommentResponse>();
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const currentProjectIdRef = useRef(projectId);
  const currentTabRef = useRef(activeTab);
  const rawAssetsRef = useRef(rawAssets);
  const autohdrObservedRef = useRef<{ handoffId: string; jobId: string } | null>(null);
  const assetRequestRef = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const loadRunRef = useRef(0);
  const workspaceReadyRunRef = useRef<{ projectId: string; run: number } | null>(null);
  const initialRawTabHandledRef = useRef<number | null>(null);
  currentProjectIdRef.current = projectId;
  currentTabRef.current = activeTab;
  rawAssetsRef.current = rawAssets;

  const toast = useCallback((message: string, tone: "success" | "error" = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3600);
  }, []);
  useEffect(() => {
    if (!notice) return;
    toast(notice);
    onNoticeShown?.();
  }, [notice, onNoticeShown, toast]);
  const ready = useCallback(() => workspaceReadyRunRef.current?.projectId === projectId && workspaceReadyRunRef.current.run === loadRunRef.current && viewState === "full-workspace", [projectId, viewState]);
  const refreshProject = useCallback(async () => { if (projectId && ready()) setData(await apiGet<ProjectResponse>(`/api/projects/${projectId}`)); }, [projectId, ready]);
  const refreshAssets = useCallback(async (kind = activeTab) => {
    if (!projectId || !ready()) return;
    const request = assetRequestRef.current;
    request.controller?.abort();
    const controller = new AbortController();
    const generation = request.generation + 1;
    assetRequestRef.current = { generation, controller };
    const response = await apiGet<AssetsResponse>(`/api/projects/${projectId}/assets?collection=${kind}`, { signal: controller.signal });
    if (assetRequestRef.current.generation !== generation || currentProjectIdRef.current !== projectId || currentTabRef.current !== kind) return;
    setAssets(response.assets);
    if (kind === "raw") setRawAssets(response.assets);
  }, [activeTab, projectId, ready]);
  const refreshIngest = useCallback(async () => { if (projectId && ready()) setIngest(await apiGet<IngestStatus>(`/api/projects/${projectId}/ingest-status`)); }, [projectId, ready]);
  const refreshJobs = useCallback(async (): Promise<Job[]> => {
    if (!projectId || !canAdminBackend || !ready()) return [];
    const fetched = (await apiGet<JobsResponse>(`/api/projects/${projectId}/jobs`)).jobs;
    setJobs(fetched);
    return fetched;
  }, [canAdminBackend, projectId, ready]);
  const refresh = useCallback(async () => { await Promise.all([refreshAssets(), refreshIngest(), ...(canAdminBackend ? [refreshJobs()] : [])]); }, [canAdminBackend, refreshAssets, refreshIngest, refreshJobs]);
  const refreshEditedCollection = useCallback(async () => {
    if (!projectId || !canViewEdited || !ready()) return;
    const response = await apiGet<AssetsResponse>(`/api/projects/${projectId}/assets?collection=edited`);
    if (currentProjectIdRef.current === projectId && currentTabRef.current === "edited") setAssets(response.assets);
  }, [canViewEdited, projectId, ready]);
  const refreshAutohdrStatus = useCallback(async () => {
    if (!projectId || !canAdminBackend || !ready()) return null;
    const response = await apiGet<AutoHdrStatusResponse>(`/api/projects/${projectId}/autohdr-status`);
    if (currentProjectIdRef.current === projectId) setAutohdrStatus(response.handoff);
    return response.handoff;
  }, [canAdminBackend, projectId, ready]);

  useEffect(() => {
    const run = ++loadRunRef.current;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && loadRunRef.current === run && currentProjectIdRef.current === projectId;
    assetRequestRef.current.controller?.abort();
    workspaceReadyRunRef.current = null; initialRawTabHandledRef.current = null;
    setData(null); setAssets([]); setRawAssets([]); setIngest(null); setJobs([]); setFallbackComments(undefined); setAutohdrStatus(null);
    setOpenAssetId(null); setLightboxOrderIds(null); setActiveTab("raw"); setError(null); setViewState("loading");
    if (!projectId) { setViewState("unavailable"); return () => controller.abort(); }
    const load = async () => {
      let project: ProjectResponse;
      try {
        project = await apiGet<ProjectResponse>(`/api/projects/${projectId}`, { signal: controller.signal });
      } catch (reason) {
        if (!current()) return;
        if (reason instanceof ApiError && reason.status === 403) {
          try {
            const response = await apiGet<CommentResponse>(`/api/projects/${projectId}/comments?limit=50`, { signal: controller.signal });
            if (!current()) return;
            setFallbackComments(response); setViewState("collaboration-only");
          } catch {
            if (current()) { setError(reason.message); setViewState("unavailable"); }
          }
        } else { setError(reason instanceof Error ? reason.message : "Project details could not be loaded."); setViewState("unavailable"); }
        return;
      }
      if (!current()) return;
      try {
        const jobsRequest: Promise<JobsResponse | null> = canAdminBackend ? apiGet<JobsResponse>(`/api/projects/${projectId}/jobs`, { signal: controller.signal }) : Promise.resolve(null);
        const [raw, status, jobList] = await Promise.all([
          apiGet<AssetsResponse>(`/api/projects/${projectId}/assets?collection=raw`, { signal: controller.signal }),
          apiGet<IngestStatus>(`/api/projects/${projectId}/ingest-status`, { signal: controller.signal }), jobsRequest,
        ]);
        if (!current()) return;
        setData(project); setAssets(raw.assets); setRawAssets(raw.assets); setIngest(status); setJobs(jobList?.jobs ?? []);
        initialRawTabHandledRef.current = run;
        workspaceReadyRunRef.current = { projectId, run };
        if (canViewEdited && (project.stageKey === "editing_autohdr" || project.stageKey === "edited_review" || project.stageKey === "delivered")) setActiveTab("edited");
        setViewState("full-workspace");
      } catch (reason) {
        if (!current()) return;
        setError(reason instanceof Error ? reason.message : "Project workspace could not be loaded.");
        setViewState("unavailable");
      }
    };
    void load();
    return () => controller.abort();
  }, [canAdminBackend, canViewEdited, projectId]);

  useEffect(() => {
    const readyRun = workspaceReadyRunRef.current;
    if (viewState !== "full-workspace" || !readyRun || readyRun.projectId !== projectId || readyRun.run !== loadRunRef.current) return;
    if (initialRawTabHandledRef.current === readyRun.run) {
      initialRawTabHandledRef.current = null;
      if (activeTab === "raw") return;
    }
    // Restore the RAW collection synchronously, or clear to empty for every other tab (no
    // equivalent cache exists for Edited/video/floorplan/copy) — then refresh under the same
    // generation guard as every other tab. This never leaves one collection's assets under
    // another collection's controls once the refresh below settles. A residual single-render
    // window remains (React commits this render with the new activeTab before this effect runs)
    // — not fully closed here by design, see docs/plans/ProjectWorkspace-Asset-Tab-Sync-Plan.md.
    setAssets(activeTab === "raw" ? rawAssetsRef.current : []);
    // A lightbox left open across a tab switch would either show the wrong collection's asset
    // or, once assets clears above, crash on an out-of-range index (Lightbox.tsx dereferences
    // assets[index] without a bounds check) — close it rather than try to keep it valid.
    setOpenAssetId(null);
    setLightboxOrderIds(null);
    void refreshAssets(activeTab).catch((reason: unknown) => {
      if (reason instanceof Error && reason.name === "AbortError") return;
      toast(reason instanceof Error ? reason.message : "Collection could not be loaded.", "error");
    });
  }, [activeTab, projectId, refreshAssets, toast, viewState]);

  useEffect(() => {
    if (viewState !== "full-workspace" || !canAdminBackend || !projectId || !jobs.some(activeJob)) return;
    const refreshUntilTerminal = () => { void Promise.all([refreshJobs(), refreshAssets("edited"), refreshProject()]).catch(() => undefined); };
    const interval = window.setInterval(refreshUntilTerminal, 5_000);
    return () => window.clearInterval(interval);
  }, [canAdminBackend, jobs, projectId, refreshAssets, refreshJobs, refreshProject, viewState]);

  useEffect(() => {
    setAutohdrStatus(null);
    autohdrObservedRef.current = null;
  }, [projectId]);

  useEffect(() => {
    if (viewState !== "full-workspace" || !canAdminBackend || !projectId || data?.id !== projectId || (data.stageKey !== "raw_review" && data.stageKey !== "editing_autohdr")) return;
    let isMounted = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const handoff = await refreshAutohdrStatus();
        if (!isMounted) return;
        const isActive = handoff?.state === "started" && handoff.mappingState === "active";
        if (isActive) {
          const freshJobs = await refreshJobs();
          if (!isMounted) return;
          const fetchJob = freshJobs.find((job) =>
            job.kind === "fetch_edited" &&
            job.correlationId === `fetch_edited:${projectId}:${handoff.generation}`);
          const alreadyObserved =
            autohdrObservedRef.current?.handoffId === handoff.id &&
            autohdrObservedRef.current?.jobId === fetchJob?.id;
          if (fetchJob && !alreadyObserved) {
            if (fetchJob.status === "queued" || fetchJob.status === "running") {
              autohdrObservedRef.current = { handoffId: handoff.id, jobId: fetchJob.id };
            } else if (fetchJob.status === "done" || fetchJob.status === "failed" || fetchJob.status === "stuck") {
              void refreshAssets("edited");
              autohdrObservedRef.current = { handoffId: handoff.id, jobId: fetchJob.id };
            }
          }
        }
        if (handoff && data.stageKey === "raw_review") void refreshProject();
        const terminal = handoff !== null && (handoff.state === "retired" || handoff.state === "failed");
        const blocked = handoff?.state === "blocked" || handoff?.mappingState === "blocked_collision";
        if (isMounted && !terminal && !blocked) timer = window.setTimeout(poll, 5_000);
      } catch {
        if (isMounted) timer = window.setTimeout(poll, 5_000);
      }
    };
    void poll();
    return () => {
      isMounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [canAdminBackend, data?.id, data?.stageKey, projectId, refreshAssets, refreshAutohdrStatus, refreshJobs, refreshProject, viewState]);

  const consumedTerminalSignalRef = useRef<number>();
  useEffect(() => {
    if ((viewState !== "collaboration-only" && viewState !== "unavailable") || collaborationOpenSignal === undefined || collaborationOpenSignal === consumedTerminalSignalRef.current) return;
    consumedTerminalSignalRef.current = collaborationOpenSignal;
    onCollaborationOpenSignalConsumed?.(collaborationOpenSignal);
  }, [collaborationOpenSignal, onCollaborationOpenSignalConsumed, viewState]);

  const updateReview = useCallback(async (assetId: string, patch: ReviewPatch) => {
    const before = assets.find((asset) => asset.id === assetId); if (!before) return;
    const review = { ...(before.review ?? emptyReview()), ...patch };
    const replace = (list: WorkspaceAsset[]) => list.map((asset) => asset.id === assetId ? { ...asset, review } : asset);
    setAssets(replace); if (activeTab === "raw") setRawAssets(replace);
    try { await apiPost(`/api/assets/${assetId}/review`, patch); }
    catch (reason) { setAssets((current) => current.map((asset) => asset.id === assetId ? before : asset)); if (activeTab === "raw") setRawAssets((current) => current.map((asset) => asset.id === assetId ? before : asset)); toast(reason instanceof Error ? reason.message : "The review change could not be saved.", "error"); }
  }, [activeTab, assets, toast]);
  const updateSelection = useCallback(async (assetId: string, selected: boolean) => {
    const before = rawAssets.find((asset) => asset.id === assetId); if (!before) return;
    const replace = (list: WorkspaceAsset[]) => list.map((asset) => asset.id === assetId ? { ...asset, selected } : asset);
    setRawAssets(replace); if (activeTab === "raw") setAssets(replace);
    try {
      if (selected) await apiPost(`/api/assets/${assetId}/select`, {});
      else { const response = await fetch(`/api/assets/${assetId}/select`, { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } }); if (!response.ok) throw new Error("Selection could not be saved."); }
    } catch (reason) { setRawAssets((current) => current.map((asset) => asset.id === assetId ? before : asset)); if (activeTab === "raw") setAssets((current) => current.map((asset) => asset.id === assetId ? before : asset)); toast(reason instanceof Error ? reason.message : "The selection could not be saved.", "error"); }
  }, [activeTab, rawAssets, toast]);
  const updateCover = useCallback(async (assetId: string | null) => {
    if (!projectId) return;
    try {
      await apiPost<{ coverAssetId: string | null }, { assetId: string | null }>(`/api/projects/${projectId}/cover`, { assetId });
      await refreshProject();
      toast(assetId === null ? "Cover cleared — using the first RAW frame." : "Cover updated.");
    } catch (reason) { toast(reason instanceof Error ? reason.message : "The project cover could not be updated.", "error"); }
  }, [projectId, refreshProject, toast]);

  const deleteAsset = useCallback(async (assetId: string) => {
    try {
      const response = await apiDelete<AssetDeleteResponse>(`/api/assets/${encodeURIComponent(assetId)}`);
      // Close only once the delete is confirmed — a blocked/failed request (e.g. a 409 from a
      // premium unlock) must not close the lightbox on an asset that's still live. Closing here,
      // before the refetch below, still avoids Lightbox dereferencing a since-filtered-out asset.
      if (deletedAssetClosesLightbox(openAssetId, response.deletedAssetIds)) { setOpenAssetId(null); setLightboxOrderIds(null); }
      await refreshAfterAssetDelete(refreshAssets, refreshProject);
      const needsAttention = response.dropboxOutcome === "failed" || response.dropboxOutcome === "claimLost";
      toast(needsAttention ? "Asset deleted, but Dropbox cleanup needs attention." : "Asset deleted.", needsAttention ? "error" : "success");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "The asset could not be deleted.", "error");
      throw reason;
    }
  }, [openAssetId, refreshAssets, refreshProject, toast]);

  const deleteAssets = useCallback(async (assetIds: string[]) => {
    const results = await Promise.allSettled(assetIds.map((assetId) => apiDelete<AssetDeleteResponse>(`/api/assets/${encodeURIComponent(assetId)}`)));
    const { succeededIds, failedIds, dropboxCleanupWarnings } = computeBulkDeleteOutcome(assetIds, results);
    if (deletedAssetClosesLightbox(openAssetId, succeededIds)) { setOpenAssetId(null); setLightboxOrderIds(null); }
    try { await refreshAfterAssetDelete(refreshAssets, refreshProject); }
    catch (refreshFailure) { toast(refreshFailure instanceof Error ? refreshFailure.message : "The project could not be refreshed after deletion.", "error"); throw refreshFailure; }
    if (failedIds.length) toast(`${failedIds.length} asset${failedIds.length === 1 ? "" : "s"} could not be deleted.`, "error");
    else if (dropboxCleanupWarnings) toast(`Deleted, but Dropbox cleanup needs attention for ${dropboxCleanupWarnings} asset${dropboxCleanupWarnings === 1 ? "" : "s"}.`, "error");
    else toast("Selected assets deleted.");
    return { succeededIds, failedIds };
  }, [openAssetId, refreshAssets, refreshProject, toast]);

  async function syncDropbox() {
    if (!projectId) return;
    setIsSyncing(true);
    try {
      const response = await apiPost<DropboxSyncResponse, Record<string, never>>(`/api/projects/${projectId}/sync-dropbox`, {});
      for (let count = 0; count < 6; count += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 2500));
        await Promise.all([refresh(), refreshEditedCollection(), refreshAutohdrStatus()]);
      }
      const queued = [response.raw, response.edited].filter((source) => "jobId" in source).length;
      const needsAttention = [response.raw, response.edited].some((source) => "blocked" in source || ("skipped" in source && source.skipped === "error"));
      toast(needsAttention ? "Dropbox check complete — some sources need attention." : queued ? `Dropbox check complete — ${queued} source${queued === 1 ? "" : "s"} queued.` : "Dropbox check complete.", needsAttention ? "error" : "success");
    }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Dropbox sync could not be started.", "error"); }
    finally { setIsSyncing(false); }
  }
  async function sendToAutoHdr() {
    if (!projectId || !canAdminBackend) return;
    setIsSending(true);
    try {
      const response = await apiPost<{ jobId: string }, { startNewRound?: boolean; removalSetHash?: string }>(`/api/projects/${projectId}/send-to-autohdr`, {});
      await Promise.all([refreshJobs(), refreshProject()]);
      toast(`Sent to autoHDR (${response.jobId.slice(0, 8)}).`);
    } catch (reason) {
      const payload = reason instanceof ApiError && reason.details && typeof reason.details === "object" ? reason.details as Record<string, unknown> : null;
      if (payload?.code === "ERR_HANDOFF_ALREADY_ACTIVE") {
        const count = typeof payload.removalCount === "number" ? payload.removalCount : 0;
        const hash = typeof payload.removalSetHash === "string" ? payload.removalSetHash : undefined;
        const removalCopy = count === 0
          ? "No previously-sent images are currently eligible for removal."
          : `This will also remove ${count} previously-sent image${count === 1 ? "" : "s"} from the AutoHDR folder because ${count === 1 ? "it is" : "they are"} no longer selected.`;
        const confirmed = window.confirm(`Any AutoHDR output for the previous round that's still being delivered may be lost. Wait until it's finished before starting a new round.\n\n${removalCopy}\n\nContinue?`);
        if (confirmed) {
          try {
            const response = await apiPost<{ jobId: string }, { startNewRound: true; removalSetHash?: string }>(`/api/projects/${projectId}/send-to-autohdr`, { startNewRound: true, removalSetHash: hash });
            await Promise.all([refreshJobs(), refreshProject()]);
            toast(`Sent new round to autoHDR (${response.jobId.slice(0, 8)}).`);
          } catch (retryReason) {
            const retryPayload = retryReason instanceof ApiError && retryReason.details && typeof retryReason.details === "object" ? retryReason.details as Record<string, unknown> : null;
            if (retryPayload?.code === "ERR_REMOVAL_SET_CHANGED") {
              await sendToAutoHdr();
            } else {
              toast(retryReason instanceof Error ? retryReason.message : "The new AutoHDR round could not be started.", "error");
            }
          }
        }
      } else {
        toast(reason instanceof Error ? reason.message : "autoHDR could not be started.", "error");
      }
    }
    finally { setIsSending(false); }
  }
  function downloadSelectedRaw() {
    if (!projectId || selectionCount === 0) return;
    toast("Preparing your download…");
    const link = document.createElement("a"); link.href = `/api/projects/${encodeURIComponent(projectId)}/selected-raw.zip`; link.download = ""; document.body.append(link); link.click(); link.remove();
  }
  const downloadSelection = useCallback(async (assetIds: string[]) => {
    if (!projectId) return;
    try {
      toast("Preparing your download…");
      const response = await apiPost<DownloadSelectionResponse, { assetIds: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/download-selection`, { assetIds });
      const link = document.createElement("a"); link.href = response.downloadUrl; link.download = ""; document.body.append(link); link.click(); link.remove();
    } catch (reason) {
      toast(reason instanceof ApiError ? reason.message : reason instanceof Error ? reason.message : "Your download could not be prepared.", "error");
      throw reason;
    }
  }, [projectId, toast]);
  async function retryAutoHdr(jobId: string) {
    if (!canAdminBackend) return;
    try { await apiPost<{ jobId: string }, Record<string, never>>(`/api/jobs/${jobId}/retry`, {}); await Promise.all([refreshJobs(), refreshProject()]); toast("Background job retry started."); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Background job retry could not be started.", "error"); }
  }

  if (viewState === "loading") return <main className="page"><div className="empty"><span className="serif">Loading project.</span>Preparing the workspace.</div><div className="toasts">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div></main>;
  if (viewState === "collaboration-only" && fallbackComments) return <main className="page project-collaboration-only"><div className="pagehead"><div><div className="ey">Collaboration</div><h1 className="serif">{fallbackComments.project.street}</h1></div><InternalLink className="button button--secondary" to="/">Back to dashboard</InternalLink></div><ProjectCollaborationPanel projectId={projectId} mode="standalone" initialComments={fallbackComments} /></main>;
  if (viewState !== "full-workspace" || error || !data) return <main className="page"><div className="pagehead"><h1 className="serif">Project workspace</h1><InternalLink className="button button--secondary" to="/">Back to dashboard</InternalLink></div><div className="empty" role="alert"><span className="serif">Project unavailable.</span>{error ?? "No project was selected."}</div><div className="toasts">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div></main>;

  const project = data;
  const { collections, members } = data;
  const stage = stages.find((item) => item.key === presentationStageKey(project.stageKey));
  const canUpload = can("uploadRaw"), canSelect = can("selectForEditing"), canEdit = can("editProject"), canManageCollections = can("editProject") || can("manageExtras"), canDeleteAssets = can("adminBackend"), isEdited = activeTab === "edited";
  const canReview = isEdited ? can("reviewEdited") : can("selectForEditing");
  const canRecommend = activeTab === "raw" && can("recommendRaw");
  const canAnnotate = activeTab === "raw" ? can("annotateRaw") : isEdited && can("annotateEdited");
  const availableTabs: Collection["kind"][] = can("viewEdited") ? ["raw", "edited", "video", "floorplan", "copy"] : ["raw"];
  const photographers = members.filter((member) => member.roleOnProject === "photographer");
  const rawCollection = collections.find((collection) => collection.kind === "raw");
  const selectionCount = rawAssets.filter((asset) => asset.selected).length;
  // Every Dropbox destination is derived from the RAW folder, and an edited upload stays invisible
  // until it is published there. Without one the API refuses the upload, so never offer the picker.
  const hasRawFolder = Boolean(project.rawFolderPath || project.rawFolderLink);
  const autohdrTerminal = autohdrStatus?.state === "retired" || autohdrStatus?.state === "failed";
  const autohdrBlocked = !autohdrTerminal && (autohdrStatus?.state === "blocked" || autohdrStatus?.mappingState === "blocked_collision");
  const autohdrStatusLabel = autohdrBlocked ? "Blocked — staff resolution needed"
    : isSyncing ? "Checking Dropbox…"
      : autohdrStatus?.mappingState === "active" ? "Fetched"
        : autohdrStatus?.state === "started" ? "Waiting for AutoHDR output"
          : "Not yet sent to autoHDR";
  const autohdrMessage = autohdrBlocked
    ? (autohdrStatus?.diagnostic ?? "AutoHDR output needs staff resolution before it can be fetched.")
    : "Pull finished edits from autoHDR's 04-FINAL-Photos into this collection.";

  return <main className="work">
    <aside className="rail"><div style={{ marginBottom: 10 }}><StatusBadge stageKey={project.stageKey} /></div><h2 className="serif">{project.street}</h2><div className="ey" style={{ marginTop: 8 }}>{[project.suburb, project.postcode].filter(Boolean).join(" · ")}</div>
      <div className="rail__sec"><div className="kv"><span className="k">Agency</span><span className="vv">{project.agencyName ?? "—"}</span></div><div className="kv"><span className="k">Agent</span><span className="vv">{project.agentName ?? "—"}</span></div><div className="kv"><span className="k">Shoot</span><span className="vv">{date(project.shootDate)}</span></div><div className="kv"><span className="k">Stage</span><span className="vv">{stage?.label ?? project.stageKey}</span></div>{canEdit && <InternalLink className="button button--secondary rail__edit" to={`/projects/${encodeURIComponent(projectId)}/edit`}>Edit details</InternalLink>}</div>
      <div className="rail__sec"><div className="ey" style={{ marginBottom: 10 }}>Photographers</div>{photographers.length ? photographers.map((member) => <div className="member" key={member.id}>{member.name || member.email}</div>) : <div className="muted">Not assigned</div>}</div>
      <div className="rail__sec"><div className="ey" style={{ marginBottom: 10 }}>Collections</div><div className="filterlist">{availableTabs.map((tab) => { const collection = collections.find((item) => item.kind === tab); return <button className={`frow ${activeTab === tab ? "is-active" : ""}`} type="button" key={tab} onClick={() => setActiveTab(tab)}><span>{collectionLabel(tab)}</span><span className="cnt">{collection ? collection.receivedCount : "—"}</span></button>; })}</div></div>
      {canUpload && (hasRawFolder || canAdminBackend) && <div className="rail__sec"><div className="ey" style={{ marginBottom: 10 }}>Dropbox</div><button className="dropcard" type="button" disabled={isSyncing} onClick={() => void syncDropbox()}><span>◈</span><span>{isSyncing ? "Syncing Dropbox…" : "Sync from Dropbox"}</span>{autohdrBlocked && <span className="statetag st-flagged">Blocked</span>}</button></div>}
    </aside>
    <section className="workmain"><div className="wsbar"><InternalLink className="chip" to="/">← Dashboard</InternalLink><span className="ey">{activeTab === "raw" ? `RAW capture · ${rawCollection?.receivedCount ?? 0} received` : `${collectionLabel(activeTab)} collection`}</span><div className="grow" /></div>
      {ingest?.mismatch && <div className="ingest-warning" role="alert"><strong>Capture count needs attention.</strong> Expected {ingest.expectedCount}, received {ingest.receivedCount}.</div>}
      {activeTab === "raw" || activeTab === "edited" ? <><div className="workspace-intro"><div><div className="ey">{activeTab === "raw" ? "Capture QA" : "Edited QA"}</div><h1 className="serif">{activeTab === "raw" ? "RAW frames" : "Edited frames"}</h1></div><div className="muted">{activeTab === "raw" ? "Ratings from XMP are shown at ingest. Select the strongest frames for editing." : "Review delivered edits before they move to client delivery."}</div></div>
        {canAdminBackend && activeTab === "raw" && canSelect && <div className="hdr"><div className="grow"><strong>autoHDR hand-off</strong><div className="muted">{selectionCount} selected RAW frame{selectionCount === 1 ? "" : "s"} will be sent for editing.</div></div><div className="row gap2"><button className="button button--secondary" type="button" disabled={selectionCount === 0} onClick={downloadSelectedRaw}>{`Download ${selectionCount} selected (zip)`}</button><button className="button" type="button" disabled={selectionCount === 0 || isSending} onClick={() => void sendToAutoHdr()}>{isSending ? "Sending…" : `Send ${selectionCount} selected to autoHDR`}</button></div></div>}
        {canAdminBackend && activeTab === "edited" && <div className="hdr" role="status"><div className="grow"><strong>autoHDR status</strong><div className={`muted${autohdrBlocked ? " notice" : ""}`}>{autohdrStatusLabel}</div><div className="muted">{autohdrMessage}</div></div></div>}
        {activeTab === "raw" && canUpload && <div className="workgrid"><UploadDropzone projectId={projectId} onComplete={refresh} onToast={toast} /></div>}
        {activeTab === "edited" && can("uploadEdited") && <div className="workgrid">{hasRawFolder
          ? <UploadDropzone projectId={projectId} collection="edited" onComplete={async () => { await Promise.all([refreshAssets("edited"), refreshProject()]); }} onToast={toast} />
          : <div className="empty" role="status"><span className="serif">No Dropbox RAW folder for this shoot.</span>Edited uploads are published to Dropbox before they appear here, and every destination is derived from the RAW folder. Create the shoot folder in Tonomo, then set the RAW folder on this project{canEdit ? " under Edit details" : ""}.</div>}</div>}
        <PhotoGrid key={activeTab} assets={assets} showSections={activeTab === "raw" || activeTab === "edited"} canReview={canReview} canRecommend={canRecommend} canSelect={activeTab === "raw" && canSelect} canSetCover={canEdit && (activeTab === "raw" || activeTab === "edited")} canDelete={canDeleteAssets} canDownloadSelection={activeTab === "raw" ? can("selectForEditing") : can("downloadFinal")} coverAssetId={project.effectiveCoverAssetId} storedCoverAssetId={project.coverAssetId} onSetCover={updateCover} onOpen={(asset, orderedAssets) => { setLightboxOrderIds(orderedAssets.map((item) => item.id)); setOpenAssetId(asset.id); }} onReview={updateReview} onSelection={updateSelection} onDelete={deleteAsset} onBulkDelete={deleteAssets} onDownloadSelection={downloadSelection} />
      </> : <CollectionPanel projectId={projectId} collection={activeTab} assets={assets} canManage={canManageCollections} canDelete={canDeleteAssets} canApprove={can("reviewEdited")} onReview={updateReview} onDelete={deleteAsset} onChanged={async () => { await Promise.all([refreshAssets(activeTab), refreshProject()]); }} onToast={toast} />}
      {canAdminBackend && jobs.length > 0 && <div className="workgrid"><section className="hdr" style={{ alignItems: "flex-start", flexDirection: "column" }}><div><strong>autoHDR status</strong><div className="muted">Recent hand-offs, fetches, and manual-upload publishes for this project.</div></div>{jobs.map((job) => <div className="kv" style={{ width: "100%" }} key={job.id}><span className="k">{new Date(job.createdAt).toLocaleString("en-AU")}</span><span className="vv"><span className="k">{job.kind === "fetch_edited" ? "Fetch" : job.kind === "autohdr_scaffold" ? "Scaffold" : job.kind === "manual_edited_publish" ? "Manual upload" : "Send"}</span>{" "}<span className={`statetag st-${job.status}`}>{job.status}</span>{job.error ? ` ${job.error}` : ""}{(job.status === "stuck" || job.status === "failed") && <button className="chip" style={{ marginLeft: 8 }} type="button" onClick={() => void retryAutoHdr(job.id)}>Retry</button>}</span></div>)}</section></div>}
    </section>
    <ProjectCollaborationPanel projectId={projectId} openSignal={collaborationOpenSignal} onOpenSignalConsumed={onCollaborationOpenSignalConsumed} />
    {openAssetId && <Lightbox assets={lightboxOrderIds ? lightboxOrderIds.map((id) => assets.find((asset) => asset.id === id)).filter((asset): asset is WorkspaceAsset => Boolean(asset)) : assets} rawAssets={rawAssets} initialAssetId={openAssetId} collectionKind={activeTab === "edited" ? "edited" : "raw"} canReview={canReview} canRecommend={canRecommend} canAnnotate={canAnnotate} onClose={() => { setOpenAssetId(null); setLightboxOrderIds(null); }} onReview={updateReview} onToast={toast} />}
    <div className="toasts">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div>
  </main>;
}
