import { useCallback, useEffect, useState } from "react";
import { DEFAULT_STAGES, type StageKey } from "@quincy/shared";
import { StatusBadge } from "../components/atoms";
import { Lightbox } from "../components/Lightbox";
import { PhotoGrid, type Review, type ReviewPatch, type WorkspaceAsset } from "../components/PhotoGrid";
import { UploadDropzone } from "../components/UploadDropzone";
import { apiGet, apiPost } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";

type Collection = { id: string; kind: "raw" | "edited" | "video" | "floorplan" | "copy"; status: string; expectedCount: number | null; receivedCount: number };
type Member = { id: string; userId: string; roleOnProject: "photographer" | "editor"; name: string; email: string };
type Project = { id: string; street: string; suburb: string | null; postcode: string | null; agencyName: string | null; agentName: string | null; shootDate: string | null; stageKey: StageKey; rawFolderPath: string | null; rawFolderLink: string | null };
type ProjectResponse = { project: Project; collections: Collection[]; members: Member[] };
type AssetsResponse = { assets: WorkspaceAsset[] };
type IngestStatus = { expectedCount: number | null; receivedCount: number; mismatch: boolean };
type Job = { id: string; kind: "autohdr"; status: "queued" | "running" | "done" | "failed" | "stuck"; error: string | null; createdAt: string; updatedAt: string };
type JobsResponse = { jobs: Job[] };
type Toast = { id: number; message: string; tone: "success" | "error" };

function date(value: string | null) { return value ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)) : "Shoot date pending"; }
function collectionLabel(value: string) { return value === "raw" ? "RAW" : value.charAt(0).toUpperCase() + value.slice(1); }
function emptyReview(): Review { return { stars: null, colorLabel: null, decision: null, recommended: false }; }
function activeJob(job: Job) { return job.status === "queued" || job.status === "running"; }

export function ProjectWorkspace({ projectId, onBack }: { projectId: string | null; onBack: () => void }) {
  const { can, role } = useCapabilities();
  const [data, setData] = useState<ProjectResponse | null>(null);
  const [assets, setAssets] = useState<WorkspaceAsset[]>([]);
  const [rawAssets, setRawAssets] = useState<WorkspaceAsset[]>([]);
  const [ingest, setIngest] = useState<IngestStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeTab, setActiveTab] = useState<Collection["kind"]>("raw");
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, tone: "success" | "error" = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3600);
  }, []);
  const refreshProject = useCallback(async () => { if (projectId) setData(await apiGet<ProjectResponse>(`/api/projects/${projectId}`)); }, [projectId]);
  const refreshAssets = useCallback(async (kind = activeTab) => {
    if (!projectId) return;
    const response = await apiGet<AssetsResponse>(`/api/projects/${projectId}/assets?collection=${kind}`);
    if (kind === activeTab) setAssets(response.assets);
    if (kind === "raw") setRawAssets(response.assets);
  }, [activeTab, projectId]);
  const refreshIngest = useCallback(async () => { if (projectId) setIngest(await apiGet<IngestStatus>(`/api/projects/${projectId}/ingest-status`)); }, [projectId]);
  const refreshJobs = useCallback(async () => { if (projectId) setJobs((await apiGet<JobsResponse>(`/api/projects/${projectId}/jobs`)).jobs); }, [projectId]);
  const refresh = useCallback(async () => { await Promise.all([refreshAssets(), refreshIngest(), refreshJobs()]); }, [refreshAssets, refreshIngest, refreshJobs]);

  useEffect(() => {
    if (!projectId) { setIsLoading(false); return; }
    let alive = true;
    setIsLoading(true); setError(null); setActiveTab("raw");
    Promise.all([apiGet<ProjectResponse>(`/api/projects/${projectId}`), apiGet<AssetsResponse>(`/api/projects/${projectId}/assets?collection=raw`), apiGet<IngestStatus>(`/api/projects/${projectId}/ingest-status`), apiGet<JobsResponse>(`/api/projects/${projectId}/jobs`)])
      .then(([project, raw, status, jobList]) => { if (alive) { setData(project); setAssets(raw.assets); setRawAssets(raw.assets); setIngest(status); setJobs(jobList.jobs); } })
      .catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : "Project details could not be loaded."); })
      .finally(() => { if (alive) setIsLoading(false); });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || activeTab === "raw") return;
    void refreshAssets(activeTab).catch((reason: unknown) => toast(reason instanceof Error ? reason.message : "Collection could not be loaded.", "error"));
  }, [activeTab, projectId, refreshAssets, toast]);

  useEffect(() => {
    if (!projectId || !jobs.some(activeJob)) return;
    const interval = window.setInterval(() => { void refreshJobs().catch(() => undefined); }, 15_000);
    return () => window.clearInterval(interval);
  }, [jobs, projectId, refreshJobs]);

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

  async function syncDropbox() {
    if (!projectId) return;
    setIsSyncing(true);
    try { const response = await apiPost<{ jobId: string }, Record<string, never>>(`/api/projects/${projectId}/dropbox-sync`, {}); toast("Dropbox sync started."); for (let count = 0; count < 6; count += 1) { await new Promise<void>((resolve) => window.setTimeout(resolve, 2500)); await refresh(); } toast(`Dropbox sync ${response.jobId.slice(0, 8)} checked for new frames.`); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "Dropbox sync could not be started.", "error"); }
    finally { setIsSyncing(false); }
  }
  async function sendToAutoHdr() {
    if (!projectId) return;
    setIsSending(true);
    try { const response = await apiPost<{ jobId: string }, Record<string, never>>(`/api/projects/${projectId}/send-to-autohdr`, {}); await Promise.all([refreshJobs(), refreshProject()]); toast(`Sent to autoHDR (${response.jobId.slice(0, 8)}).`); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "autoHDR could not be started.", "error"); }
    finally { setIsSending(false); }
  }
  async function retryAutoHdr(jobId: string) {
    try { await apiPost<{ jobId: string }, Record<string, never>>(`/api/jobs/${jobId}/retry`, {}); await Promise.all([refreshJobs(), refreshProject()]); toast("autoHDR retry started."); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "autoHDR retry could not be started.", "error"); }
  }

  if (isLoading) return <main className="page"><div className="empty"><span className="serif">Loading project.</span>Preparing the workspace.</div></main>;
  if (!projectId || error || !data) return <main className="page"><div className="pagehead"><h1 className="serif">Project workspace</h1><button className="button button--secondary" type="button" onClick={onBack}>Back to dashboard</button></div><div className="empty" role="alert"><span className="serif">Project unavailable.</span>{error ?? "No project was selected."}</div></main>;

  const { project, collections, members } = data;
  const stage = DEFAULT_STAGES.find((item) => item.key === project.stageKey);
  const canUpload = can("uploadRaw"), canSelect = can("selectForEditing"), isEdited = activeTab === "edited";
  const canReview = isEdited ? can("reviewEdited") : role === "admin" || role === "editor";
  const canRecommend = activeTab === "raw" && can("recommendRaw");
  const canAnnotate = activeTab === "raw" ? can("annotateRaw") : isEdited && can("annotateEdited");
  const availableTabs: Collection["kind"][] = can("viewEdited") ? ["raw", "edited", "video", "floorplan", "copy"] : ["raw"];
  const photographers = members.filter((member) => member.roleOnProject === "photographer");
  const rawCollection = collections.find((collection) => collection.kind === "raw");
  const selectionCount = rawAssets.filter((asset) => asset.selected).length;

  return <main className="work">
    <aside className="rail"><div style={{ marginBottom: 10 }}><StatusBadge stageKey={project.stageKey} /></div><h2 className="serif">{project.street}</h2><div className="ey" style={{ marginTop: 8 }}>{[project.suburb, project.postcode].filter(Boolean).join(" · ")}</div>
      <div className="rail__sec"><div className="kv"><span className="k">Agency</span><span className="vv">{project.agencyName ?? "—"}</span></div><div className="kv"><span className="k">Agent</span><span className="vv">{project.agentName ?? "—"}</span></div><div className="kv"><span className="k">Shoot</span><span className="vv">{date(project.shootDate)}</span></div><div className="kv"><span className="k">Stage</span><span className="vv">{stage?.label ?? project.stageKey}</span></div></div>
      <div className="rail__sec"><div className="ey" style={{ marginBottom: 10 }}>Photographers</div>{photographers.length ? photographers.map((member) => <div className="member" key={member.id}>{member.name || member.email}</div>) : <div className="muted">Not assigned</div>}</div>
      <div className="rail__sec"><div className="ey" style={{ marginBottom: 10 }}>Collections</div><div className="filterlist">{availableTabs.map((tab) => { const collection = collections.find((item) => item.kind === tab); return <button className={`frow ${activeTab === tab ? "is-active" : ""}`} type="button" key={tab} onClick={() => setActiveTab(tab)}><span>{collectionLabel(tab)}</span><span className="cnt">{collection ? collection.receivedCount : "—"}</span></button>; })}</div></div>
      {canUpload && (project.rawFolderPath || project.rawFolderLink) && <div className="rail__sec"><div className="ey" style={{ marginBottom: 10 }}>Dropbox RAW folder</div><button className="dropcard" type="button" disabled={isSyncing} onClick={() => void syncDropbox()}><span>◈</span><span>{isSyncing ? "Syncing Dropbox…" : "Sync from Dropbox"}</span></button></div>}
    </aside>
    <section className="workmain"><div className="wsbar"><button className="chip" type="button" onClick={onBack}>← Dashboard</button><span className="ey">{activeTab === "raw" ? `RAW capture · ${rawCollection?.receivedCount ?? 0} received` : `${collectionLabel(activeTab)} collection`}</span><div className="grow" />{canUpload && activeTab === "raw" && <button className="chip" type="button" disabled={isSyncing || !(project.rawFolderPath || project.rawFolderLink)} onClick={() => void syncDropbox()}>Sync Dropbox</button>}</div>
      {ingest?.mismatch && <div className="ingest-warning" role="alert"><strong>Capture count needs attention.</strong> Expected {ingest.expectedCount}, received {ingest.receivedCount}.</div>}
      {activeTab === "raw" || activeTab === "edited" ? <><div className="workspace-intro"><div><div className="ey">{activeTab === "raw" ? "Capture QA" : "Edited QA"}</div><h1 className="serif">{activeTab === "raw" ? "RAW frames" : "Edited frames"}</h1></div><div className="muted">{activeTab === "raw" ? "Ratings from XMP are shown at ingest. Select the strongest frames for editing." : "Review delivered edits before they move to client delivery."}</div></div>
        {activeTab === "raw" && canSelect && <div className="hdr"><div className="grow"><strong>autoHDR hand-off</strong><div className="muted">{selectionCount} selected RAW frame{selectionCount === 1 ? "" : "s"} will be sent for editing.</div></div><button className="button" type="button" disabled={selectionCount === 0 || isSending} onClick={() => void sendToAutoHdr()}>{isSending ? "Sending…" : `Send ${selectionCount} selected to autoHDR`}</button></div>}
        {activeTab === "raw" && canUpload && <div className="workgrid"><UploadDropzone projectId={projectId} onComplete={refresh} onToast={toast} /></div>}
        <PhotoGrid assets={assets} canReview={canReview} canRecommend={canRecommend} canSelect={activeTab === "raw" && canSelect} onOpen={(asset) => setOpenAssetId(asset.id)} onReview={updateReview} onSelection={updateSelection} />
      </> : <div className="empty later-phase"><span className="serif">{collectionLabel(activeTab)} arrives in a later phase.</span>This collection is ready in the workspace, but its production view has not been connected yet.</div>}
      {jobs.length > 0 && <div className="workgrid"><section className="hdr" style={{ alignItems: "flex-start", flexDirection: "column" }}><div><strong>autoHDR status</strong><div className="muted">Recent hand-offs for this project.</div></div>{jobs.map((job) => <div className="kv" style={{ width: "100%" }} key={job.id}><span className="k">{new Date(job.createdAt).toLocaleString("en-AU")}</span><span className="vv"><span className={`statetag st-${job.status}`}>{job.status}</span>{job.error ? ` ${job.error}` : ""}{(job.status === "stuck" || job.status === "failed") && canSelect && <button className="chip" style={{ marginLeft: 8 }} type="button" onClick={() => void retryAutoHdr(job.id)}>Retry</button>}</span></div>)}</section></div>}
    </section>
    {openAssetId && <Lightbox assets={assets} rawAssets={rawAssets} initialAssetId={openAssetId} collectionKind={activeTab === "edited" ? "edited" : "raw"} canReview={canReview} canRecommend={canRecommend} canAnnotate={canAnnotate} onClose={() => setOpenAssetId(null)} onReview={updateReview} />}
    <div className="toasts">{toasts.map((item) => <div className={`toast ${item.tone === "error" ? "toast--error" : ""}`} key={item.id}>{item.tone === "error" ? "!" : "✓"}<span>{item.message}</span></div>)}</div>
  </main>;
}
