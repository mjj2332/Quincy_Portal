import type { QueryClient } from "@tanstack/react-query";
import type { Mp4Probe, Role } from "@quincy/shared";
import { useSyncExternalStore } from "react";
import { invalidateProjectSurfaces, terminatePrincipalOnUnauthorized } from "./project-data";
import { onPrincipalTerminal } from "./principal-terminal";
import { pushToast } from "./toast-store";
import { VideoUpload, abortReservation, checkVideoFile, type VideoUploadState, type VideoUploadTarget } from "./video-upload";

/**
 * Video uploads outlive the panel that started them (#741 4d-i, override 4): a 2 GB upload must survive switching Workspace tabs
 * (the tab body remounts) and closing the Project sheet. A module store, keyed by person and Project. When the signed-in person
 * changes the uploads are aborted and dropped at RENDER time (`syncUploadPrincipal`), not in an effect: an effect leaves one render
 * where the new person sees the old person's rows (docs/lessons.md, #217).
 */
type Entry = { job: VideoUpload; principalId: string; queryClient: QueryClient | undefined };

const entries = new Map<number, Entry>();
const listeners = new Set<() => void>();
let principal: string | null = null;
/** Bumps whenever the owning person changes (sign-out included). An async step that began under one owner compares it before it acts. */
let generation = 0;
let version = 0;
const snapshots = new Map<string, { version: number; rows: readonly VideoUploadState[] }>();
let nextId = 1;

let quiet = false;
function emit() { if (quiet) return; version += 1; for (const listener of listeners) listener(); updateUnloadGuard(); queueMicrotask(pump); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

const isActive = (state: VideoUploadState) => state.phase === "reserving" || state.phase === "uploading" || state.phase === "finishing";
const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
let guarded = false;
function updateUnloadGuard() {
  if (typeof window === "undefined") return;
  const any = [...entries.values()].some((entry) => isActive(entry.job.state)) || [...batches.values()].some((list) => list.some((entry) => entry.status === "queued"));
  if (any && !guarded) { window.addEventListener("beforeunload", beforeUnload); guarded = true; }
  if (!any && guarded) { window.removeEventListener("beforeunload", beforeUnload); guarded = false; }
}

const identityHandlers = new Set<() => void>();
/** Told (after render) each time the signed-in person changes or signs out. */
export function onUploadIdentityChange(handler: () => void): () => void { identityHandlers.add(handler); return () => { identityHandlers.delete(handler); }; }

/** The identity generation a caller captures before an async step (a file probe) and hands back to `startVideoUpload`. */
export const uploadIdentityGeneration = () => generation;

/** Call during render, and from the app's identity boundary (`PrincipalFreshnessBoundary`), with the signed-in person's id. A different person (or a sign-out) aborts and clears every upload. */
export function syncUploadPrincipal(userId: string | null): void {
  if (principal === userId) return;
  principal = userId;
  generation += 1;
  // After render: a handler may touch other stores (toasts) whose subscribers must not be told mid-render.
  queueMicrotask(() => { for (const handler of [...identityHandlers]) handler(); });
  // Render-time: no subscriber may be told while React is rendering, so the cancels are silent and the subscribers are told after.
  quiet = true;
  try { for (const entry of [...entries.values()]) void entry.job.cancel(); } finally { quiet = false; }
  entries.clear();
  batches.clear();
  batchSnapshots.clear();
  snapshots.clear();
  updateUnloadGuard();
  // The subscribers are told after render, not during it.
  queueMicrotask(() => { version += 1; for (const listener of listeners) listener(); });
}

// A session is over (a 401 anywhere, an access loss): the uploads started under it stop now, whether or not a Films panel is mounted. The notice names
// the session's query client, so a retired session's late 401 (even for the same account signed back in) cannot stop a fresh session's uploads.
onPrincipalTerminal((terminated) => {
  if (terminated === undefined) { syncUploadPrincipal(null); return; }
  const mine = [...entries.entries()].filter(([, entry]) => entry.queryClient === terminated);
  const queued = [...batches.entries()].filter(([, list]) => list.some((entry) => entry.queryClient === terminated));
  if (mine.length === 0 && queued.length === 0) return;
  generation += 1; // a probe still running under this session must not start
  for (const [id, entry] of mine) { void entry.job.cancel(); entries.delete(id); }
  for (const [key, list] of queued) { const rest = list.filter((entry) => entry.queryClient !== terminated); if (rest.length === 0) batches.delete(key); else batches.set(key, rest); }
  snapshots.clear();
  batchSnapshots.clear();
  updateUnloadGuard();
  queueMicrotask(() => { version += 1; for (const listener of listeners) listener(); });
});

/**
 * A batch of new films (#845). The queue lives here, not in the uploader, because a queued file is work the person already committed and must survive a tab
 * switch or a closed Project sheet. The batch only PACES the jobs it started (`NEW_FILM_BATCH_PACE` at a time); it never refuses a file and never counts the
 * person's other uploads: the server owns the limit, and its refusal comes back as a `refused` row (docs/lessons.md, #751).
 */
export const NEW_FILM_BATCH_PACE = 3;
export type NewFilmStatus = "checking" | "ready" | "rejected" | "queued" | "started" | "refused";
export type NewFilmEntry = {
  key: string; file: File; status: NewFilmStatus; probe?: Mp4Probe; cautions: string[]; message?: string;
  jobId?: number; job?: VideoUpload; reservedSettled?: boolean; role: Role; queryClient: QueryClient | undefined; generation: number;
};
const batches = new Map<string, NewFilmEntry[]>();
const batchKey = (userId: string, projectId: string) => `${userId}:${projectId}`;
let nextEntry = 1;
const batchSnapshots = new Map<string, { version: number; rows: readonly NewFilmEntry[] }>();

function patchEntry(bk: string, key: string, patch: Partial<NewFilmEntry>) {
  const list = batches.get(bk);
  if (!list?.some((entry) => entry.key === key)) return false;
  batches.set(bk, list.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  return true;
}

/** A job holds its lane from start until it is truly finished (done, cancelled, refused or failed for good). A failure parked for a manual retry keeps it: the server still counts that reservation. */
function holdsLane(entry: NewFilmEntry) {
  // The job is held by the entry itself, not looked up in `entries`: removing its tray row must not release the lane while the server may still count it.
  const job = entry.job;
  if (!job) return false;
  if (job.cleaning) return true; // an abort is unanswered
  if (job.isCancelled) return false;
  const state = job.state;
  return isActive(state) || (state.phase === "failed" && state.retry != null);
}

function pump() {
  let changed = false;
  for (const [bk, initial] of [...batches.entries()]) {
    const userId = bk.slice(0, bk.indexOf(":")), projectId = bk.slice(bk.indexOf(":") + 1);
    // A started file whose reserve has been answered and whose job is over leaves the batch. One whose reserve is unanswered stays, so a refusal is not lost.
    let list = initial.filter((entry) => !(entry.status === "started" && entry.reservedSettled && !holdsLane(entry)));
    if (list.length !== initial.length) changed = true;
    let lanes = list.filter((entry) => entry.status === "started" && holdsLane(entry)).length;
    for (const entry of list) {
      if (lanes >= NEW_FILM_BATCH_PACE) break;
      if (entry.status !== "queued") continue;
      const started = startVideoUpload({ userId, queryClient: entry.queryClient, projectId, role: entry.role, file: entry.file, target: { kind: "new" }, probe: entry.probe!, cautions: entry.cautions, identityGeneration: entry.generation });
      changed = true;
      if (!started) { list = list.filter((other) => other.key !== entry.key); continue; }
      lanes += 1;
      list = list.map((other) => (other.key === entry.key ? { ...other, status: "started", jobId: started.id, job: entries.get(started.id)?.job } : other));
      batches.set(bk, list);
      const key = entry.key;
      void started.reserved.then((refusal) => {
        if (refusal === null) patchEntry(bk, key, { reservedSettled: true }); else patchEntry(bk, key, { status: "refused", message: refusal, jobId: undefined });
        emit();
      });
    }
    if (list.length === 0) batches.delete(bk); else batches.set(bk, list);
  }
  if (changed) emit();
}

/** Check every picked file in the browser at once. Each lands as `ready` or `rejected`; nothing is requested from the server. */
export function addNewFilms(input: { userId: string; queryClient: QueryClient | undefined; projectId: string; role: Role; files: File[] }): void {
  if (principal !== null && principal !== input.userId) return;
  syncUploadPrincipal(input.userId);
  const bk = batchKey(input.userId, input.projectId);
  const mine = input.files.map((file) => ({ key: `film-${nextEntry++}`, file }));
  batches.set(bk, [...(batches.get(bk) ?? []), ...mine.map(({ key, file }): NewFilmEntry => ({ key, file, status: "checking", cautions: [], role: input.role, queryClient: input.queryClient, generation }))]);
  emit();
  for (const { key, file } of mine) {
    const checkedUnder = generation;
    void checkVideoFile(file).then((result) => {
      // The person changed while the file was read, or the row was removed: nothing to show.
      if (checkedUnder !== generation) return;
      const applied = result.ok ? patchEntry(bk, key, { status: "ready", probe: result.probe, cautions: result.cautions }) : patchEntry(bk, key, { status: "rejected", message: result.message });
      if (applied) emit();
    });
  }
}

export function removeNewFilm(key: string): void {
  for (const [bk, list] of batches) {
    const entry = list.find((candidate) => candidate.key === key);
    if (!entry || entry.status === "started") continue;
    const rest = list.filter((candidate) => candidate.key !== key);
    if (rest.length === 0) batches.delete(bk); else batches.set(bk, rest);
    emit();
    return;
  }
}

function markBatch(userId: string, projectId: string, from: NewFilmStatus, only?: string) {
  const bk = batchKey(userId, projectId);
  const list = batches.get(bk);
  if (!list || principal !== userId) return;
  batches.set(bk, list.map((entry) => (entry.status === from && (only === undefined || entry.key === only) ? { ...entry, status: "queued", message: undefined } : entry)));
  emit();
  pump();
}
/** Every `ready` film is queued and the first three start. Rejected rows are left alone. */
export const uploadNewFilms = (userId: string, projectId: string) => markBatch(userId, projectId, "ready");
/** A refused film goes back in the queue. */
export function retryNewFilm(key: string): void {
  for (const [bk, list] of batches) {
    if (list.some((entry) => entry.key === key && entry.status === "refused")) { const at = bk.indexOf(":"); markBatch(bk.slice(0, at), bk.slice(at + 1), "refused", key); return; }
  }
}

/** The rows the uploader draws: everything not yet handed to the tray. Referentially stable between changes. */
export function newFilmBatchSnapshot(userId: string | null, projectId: string): readonly NewFilmEntry[] {
  const bk = `${userId}:${projectId}`;
  const cached = batchSnapshots.get(bk);
  if (cached && cached.version === version) return cached.rows;
  const rows = userId !== null && userId === principal ? (batches.get(bk) ?? []).filter((entry) => entry.status !== "started") : [];
  const previous = cached?.rows;
  const stable = previous && previous.length === rows.length && previous.every((row, index) => row === rows[index]) ? previous : rows;
  batchSnapshots.set(bk, { version, rows: stable });
  return stable;
}
export function useNewFilmBatch(userId: string | null, projectId: string): readonly NewFilmEntry[] {
  syncUploadPrincipal(userId);
  return useSyncExternalStore(subscribe, () => newFilmBatchSnapshot(userId, projectId), () => newFilmBatchSnapshot(userId, projectId));
}

export function startVideoUpload(input: {
  userId: string; queryClient: QueryClient | undefined; projectId: string; role: Role; file: File; target: VideoUploadTarget; probe: Mp4Probe; cautions: string[];
  /** The `uploadIdentityGeneration()` captured before the async work that led here. A different one means the person changed meanwhile. */
  identityGeneration?: number;
  /** Test seam: waits between retries. */
  completeDelaysMs?: readonly number[]; partDelaysMs?: readonly number[];
}): { id: number; /** The server's answer to the reserve: `null` when it holds the upload, else why it refused. A refusal removes the row. */ reserved: Promise<string | null> } | null {
  // A stale owner (the person changed while a probe ran) must neither start an upload nor sync the store, which would cancel the new owner's.
  if (input.identityGeneration !== undefined && input.identityGeneration !== generation) return null;
  if (principal !== null && principal !== input.userId) return null;
  syncUploadPrincipal(input.userId);
  const id = nextId++;
  const job = new VideoUpload(id, {
    projectId: input.projectId, role: input.role, file: input.file, target: input.target, probe: input.probe, cautions: input.cautions,
    completeDelaysMs: input.completeDelaysMs, partDelaysMs: input.partDelaysMs,
    onChange: () => emit(),
    onServerCleaned: () => refreshVideos(input.queryClient, input.projectId),
    onUnauthorized: (error) => { if (input.queryClient) terminatePrincipalOnUnauthorized(input.queryClient, error); },
    onDone: (result) => {
      if (input.queryClient) void invalidateProjectSurfaces(input.queryClient, { projectId: input.projectId, resources: [{ kind: "videos" }, { kind: "detail" }, { kind: "activity" }], dashboard: false, calendar: false, gantt: false });
      const entry = entries.get(id);
      // Dropped already (the person changed or signed out): nothing to announce, and nothing of theirs to show the next person.
      if (!entry) return;
      pushToast(`${result.version ? `v${result.version} of ` : ""}${result.title} uploaded`);
      // A success that carries a caution keeps its row (dismissible): a toast would be gone before it was read.
      if ((entry.job.state.cautions?.length ?? 0) > 0) { emit(); return; }
      entries.delete(id);
      emit();
    },
  });
  entries.set(id, { job, principalId: input.userId, queryClient: input.queryClient });
  emit();
  job.start();
  // The server refused the reserve (a limit, a conflict): there is no upload to show, and the caller keeps the person's file and title.
  const reserved = job.reserved.then((refusal) => { if (refusal !== null && entries.get(id)?.job === job) { entries.delete(id); emit(); } return refusal; });
  return { id, reserved };
}

function refreshVideos(queryClient: QueryClient | undefined, projectId: string) {
  if (queryClient) void invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "videos" }, { kind: "detail" }], dashboard: false, calendar: false, gantt: false });
}

/**
 * Cancel: stop sending, send the abort and wait for its answer, whatever it is; then re-read the list (the server's DTO is the truth) and drop the row.
 * A "pending" answer or none is shown as a toast; the server's sweep reclaims the reservation.
 */
export async function cancelVideoUpload(id: number, queryClient?: QueryClient): Promise<void> {
  const entry = entries.get(id);
  if (!entry) return;
  await abortThenRefresh(entry, queryClient ?? entry.queryClient);
  if (entries.get(id) === entry) { entries.delete(id); emit(); }
}

/** Send the abort, wait for whatever answer comes, re-read the list, and toast a pending or missing answer. */
async function abortThenRefresh(entry: Entry, queryClient: QueryClient | undefined): Promise<void> {
  const message = await entry.job.cancel();
  refreshVideos(queryClient, entry.job.state.projectId);
  if (message) pushToast(message);
}

/** The abort request for a reservation the server holds that this tab has no job for (a stuck one, or another tab's): same contract as `cancelVideoUpload`. */
export async function abortVideoReservation(queryClient: QueryClient | undefined, projectId: string, reservationId: string): Promise<void> {
  const message = await abortReservation(projectId, reservationId);
  refreshVideos(queryClient, projectId);
  if (message) pushToast(message);
}

export const retryVideoUpload = (id: number) => { entries.get(id)?.job.retry(); };
/** Drop a finished or failed row at once. A failed or running one also asks the server to free its reservation, then re-reads the list as Cancel does. */
export function removeVideoUpload(id: number) {
  const entry = entries.get(id);
  if (!entry) return;
  if (entry.job.state.phase === "failed" || isActive(entry.job.state)) void abortThenRefresh(entry, entry.queryClient);
  entries.delete(id);
  emit();
}

function rowsFor(userId: string | null, projectId: string): readonly VideoUploadState[] {
  const key = `${userId}:${projectId}`;
  const cached = snapshots.get(key);
  if (cached && cached.version === version) return cached.rows;
  const rows = userId === principal ? [...entries.values()].filter((entry) => entry.principalId === userId && entry.job.state.projectId === projectId).map((entry) => entry.job.state) : [];
  const previous = cached?.rows;
  const stable = previous && previous.length === rows.length && previous.every((row, index) => row === rows[index]) ? previous : rows;
  snapshots.set(key, { version, rows: stable });
  return stable;
}

/** This person's uploads in this Project. A different person than the store's reads empty, and the store clears itself on that first render. */
export function useVideoUploads(userId: string | null, projectId: string): readonly VideoUploadState[] {
  syncUploadPrincipal(userId);
  return useSyncExternalStore(subscribe, () => rowsFor(userId, projectId), () => rowsFor(userId, projectId));
}

/** Test seam. */
export function resetVideoUploadStore() { for (const entry of entries.values()) void entry.job.cancel(); entries.clear(); batches.clear(); batchSnapshots.clear(); snapshots.clear(); principal = null; version += 1; listeners.clear(); updateUnloadGuard(); }
