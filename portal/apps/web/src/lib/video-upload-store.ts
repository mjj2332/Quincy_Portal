import type { QueryClient } from "@tanstack/react-query";
import type { Mp4Probe, Role } from "@quincy/shared";
import { useSyncExternalStore } from "react";
import { invalidateProjectSurfaces, terminatePrincipalOnUnauthorized } from "./project-data";
import { pushToast } from "./toast-store";
import { VideoUpload, type VideoUploadState, type VideoUploadTarget } from "./video-upload";

/**
 * Video uploads outlive the panel that started them (#741 4d-i, override 4): a 2 GB upload must survive switching Workspace tabs
 * (the tab body remounts) and closing the Project sheet. A module store, keyed by person and Project. When the signed-in person
 * changes the uploads are aborted and dropped at RENDER time (`syncUploadPrincipal`), not in an effect: an effect leaves one render
 * where the new person sees the old person's rows (docs/lessons.md, #217).
 */
type Entry = { job: VideoUpload; principalId: string };

const entries = new Map<number, Entry>();
const listeners = new Set<() => void>();
let principal: string | null = null;
let version = 0;
const snapshots = new Map<string, { version: number; rows: readonly VideoUploadState[] }>();
let nextId = 1;

const TERMINAL: ReadonlySet<string> = new Set(["done", "cancelled"]);

let quiet = false;
function emit() { if (quiet) return; version += 1; for (const listener of listeners) listener(); updateUnloadGuard(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

const isActive = (state: VideoUploadState) => state.phase === "reserving" || state.phase === "uploading" || state.phase === "finishing";
const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
let guarded = false;
function updateUnloadGuard() {
  if (typeof window === "undefined") return;
  const any = [...entries.values()].some((entry) => isActive(entry.job.state));
  if (any && !guarded) { window.addEventListener("beforeunload", beforeUnload); guarded = true; }
  if (!any && guarded) { window.removeEventListener("beforeunload", beforeUnload); guarded = false; }
}

/** Call during render with the signed-in person's id. A different person (or a sign-out) aborts and clears every upload. */
export function syncUploadPrincipal(userId: string | null): void {
  if (principal === userId) return;
  principal = userId;
  // Render-time: no subscriber may be told while React is rendering, so the cancels are silent and the subscribers are told after.
  quiet = true;
  try { for (const entry of [...entries.values()]) entry.job.cancel(); } finally { quiet = false; }
  entries.clear();
  snapshots.clear();
  updateUnloadGuard();
  // The subscribers are told after render, not during it.
  queueMicrotask(() => { version += 1; for (const listener of listeners) listener(); });
}

export function startVideoUpload(input: {
  userId: string; queryClient: QueryClient | undefined; projectId: string; role: Role; file: File; target: VideoUploadTarget; probe: Mp4Probe; cautions: string[];
  /** Test seam: waits between retries. */
  completeDelaysMs?: readonly number[]; partDelaysMs?: readonly number[];
}): number {
  syncUploadPrincipal(input.userId);
  const id = nextId++;
  const job = new VideoUpload(id, {
    projectId: input.projectId, role: input.role, file: input.file, target: input.target, probe: input.probe, cautions: input.cautions,
    completeDelaysMs: input.completeDelaysMs, partDelaysMs: input.partDelaysMs,
    onChange: () => emit(),
    onUnauthorized: (error) => { if (input.queryClient) terminatePrincipalOnUnauthorized(input.queryClient, error); },
    onSettled: (result) => {
      if (input.queryClient) void invalidateProjectSurfaces(input.queryClient, { projectId: input.projectId, resources: [{ kind: "videos" }, ...(result.outcome === "done" ? [{ kind: "activity" as const }] : [])], dashboard: false, calendar: false, gantt: false });
      if (result.outcome === "done") pushToast(`${result.version ? `v${result.version} of ` : ""}${result.title} uploaded`);
      entries.delete(id);
      emit();
    },
  });
  entries.set(id, { job, principalId: input.userId });
  emit();
  job.start();
  return id;
}

export const cancelVideoUpload = (id: number) => { entries.get(id)?.job.cancel(); };
export const retryVideoUpload = (id: number) => { entries.get(id)?.job.retry(); };
/** Drop a finished, failed or cancelled row. A failed row that still holds a reservation is cancelled first, so the server frees it. */
export function removeVideoUpload(id: number) {
  const entry = entries.get(id);
  if (!entry) return;
  if (entry.job.state.phase === "failed" || isActive(entry.job.state)) entry.job.cancel();
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

/** Uploads this person has running in this Project (reserving, uploading, finishing). The server allows three. */
export function activeUploadCount(userId: string, projectId: string): number {
  return [...entries.values()].filter((entry) => entry.principalId === userId && entry.job.state.projectId === projectId && isActive(entry.job.state)).length;
}

export const VIDEO_CLIENT_MAX_ACTIVE = 3;
export const isTerminalUpload = (state: VideoUploadState) => TERMINAL.has(state.phase);

/** Test seam. */
export function resetVideoUploadStore() { for (const entry of entries.values()) entry.job.cancel(); entries.clear(); snapshots.clear(); principal = null; version += 1; listeners.clear(); updateUnloadGuard(); }
