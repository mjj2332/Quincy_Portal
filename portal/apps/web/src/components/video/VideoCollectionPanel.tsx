import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useReportBarHeight } from "./ReviewBarClearance";
import type { Mp4Probe, Role, VideoDto, VideoReviewResponse } from "@quincy/shared";
import { useSession } from "../../lib/auth";
import { useOptionalProjectQueryClient, useProjectAccessTermination, useProjectVideosQuery } from "../../lib/project-data";
import { onPrincipalTerminal } from "../../lib/principal-terminal";
import { createNoteFormStore, type NoteFormStore } from "../../lib/video-note-form-store";
import { abortVideoReservation, cancelVideoUpload, removeVideoUpload, retryVideoUpload, startVideoUpload, uploadIdentityGeneration, useVideoUploads } from "../../lib/video-upload-store";
import { checkVideoFile } from "../../lib/video-upload";
import { ViewLoadBoundary } from "../ViewLoadBoundary";
import { Button } from "../quincy/Button";
import { EmbeddedUploadTray, type EmbeddedUpload } from "../quincy/EmbeddedUploadTray";
import { EmptyState } from "../quincy/EmptyState";
import { Notice } from "../quincy/Notice";
import { NewFilmUploader } from "./NewFilmUploader";
import { VideoCard } from "./VideoCard";
import { ReviewLinksHost, ReviewLinksOpenButton } from "./ReviewLinksHost";
import { ReviewLinkStoreContext, useReviewLinksUi } from "./use-review-links-ui";

/** The player is a separate chunk: nobody who never opens a film pays for it (#292: every lazy view sits in a ViewLoadBoundary). */
type ViewerComponent = typeof import("./VideoReviewViewer").VideoReviewViewer;
let loadedViewer: ViewerComponent | null = null;
const loadViewer = () => import("./VideoReviewViewer").then((module) => { loadedViewer = module.VideoReviewViewer; return { default: module.VideoReviewViewer }; });
const LazyViewer = lazy(loadViewer);
/** Pointing at or focusing a film starts the chunk, so Enter opens the dialog (and moves focus into it) in its own tick: a Space typed straight after would otherwise land on the Open review button while the chunk loads. */
const preloadViewer = () => { void loadViewer(); };
/** With notes on, the notes chunk starts loading along with the viewer's. */
const preloadNotes = () => { void import("./VideoNotesHost"); };

/** The Films section of the Video tab (#741 4d-i): upload, my running uploads, and a card per Video. Rendered only when the gate is open. */
export function VideoCollectionPanel({ projectId, role, review, archived = false }: { projectId: string; role: Role; review: VideoReviewResponse; /** The Project is archived: notes are read-only. */ archived?: boolean }) {
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const queryClient = useOptionalProjectQueryClient();
  const terminate = useProjectAccessTermination();
  const videos = useProjectVideosQuery(projectId, true, role);
  const uploads = useVideoUploads(userId, projectId);
  const canUpload = review.parts.includes("upload");
  const notesEnabled = review.parts.includes("notes");
  // Drawing on notes (#741 6b-ui) needs the notes part too: markup alone offers nothing.
  const markupEnabled = notesEnabled && review.parts.includes("markup");
  // Every unsent or open note form lives here for as long as the Video tab is open (#741 5b, D3): one store per person and Project, never a
  // module, so a different person starts with none. Swapped during render (the person or Project changed) so nothing the old store started
  // can send or write again; the viewer and the notes panel only subscribe to it.
  const formsRef = useRef<NoteFormStore | null>(null);
  const formsKey = `${userId ?? ""}:${projectId}`;
  if (formsRef.current?.key !== formsKey) { formsRef.current?.retire(); formsRef.current = createNoteFormStore(formsKey); }
  const forms = formsRef.current;
  useEffect(() => {
    // The notice names the session's query client: a retired session's late 401 must not cancel this session's confirmation (as in video-upload-store).
    const off = onPrincipalTerminal((terminated) => { if (terminated === undefined || terminated === queryClient) forms.cancelAll(); });
    return () => { off(); forms.cancelAll(); };
  }, [forms, queryClient]);
  // Review links (#741 11b): the store and the dialog live in `ReviewLinksScope`, above the tab switch; this reads them. Shipped dark behind the `links` part and `shareVideo`.
  const reviewLinks = useReviewLinksUi({ projectId, role, review, archived, store: useContext(ReviewLinkStoreContext) });
  // The fixed selection bar's measured height (0 while it is not shown), kept clear at the end of the collection.
  const setBarHeight = useReportBarHeight() ?? undefined;
  const running = uploads.filter((upload) => upload.phase === "reserving" || upload.phase === "uploading" || upload.phase === "finishing");
  // The component is chosen once per opening: swapping `lazy` for the loaded one mid-open would remount the viewer (playback, Version and frame lost).
  const [opened, setOpened] = useState<{ id: string; Viewer: ViewerComponent | typeof LazyViewer } | null>(null);
  const openVideoId = opened?.id ?? null;
  const Viewer = opened?.Viewer ?? LazyViewer;
  const setOpenVideoId = (id: string | null) => {
    // Once preloaded the component renders directly: `lazy` would suspend for a task even with the module in hand.
    setOpened(id ? { id, Viewer: loadedViewer ?? LazyViewer } : null);
  };
  const opener = useRef<HTMLElement | null>(null);
  const openVideo = openVideoId ? videos.data?.find((video) => video.id === openVideoId) ?? null : null;
  useEffect(() => { if (openVideoId && videos.data && !openVideo) setOpenVideoId(null); }, [openVideoId, openVideo, videos.data]);

  const rows = useMemo<EmbeddedUpload[]>(() => uploads.map((upload) => ({
    key: upload.id,
    name: upload.fileName,
    percent: upload.percent,
    kind: "video",
    phase: upload.phase === "failed" ? "failed" : upload.phase === "done" ? "done" : upload.phase === "finishing" ? "finishing" : "uploading",
    ...(upload.phase === "failed" ? { message: upload.error ?? "The upload failed.", noRetry: upload.retry === null, retryLabel: upload.retry === "finish" ? "Retry finishing" : "Retry" } : {}),
    cautions: upload.cautions,
  })), [uploads]);

  const SIGN_IN_AGAIN = "Sign in again to upload.";
  /** `generation` is the identity generation from before any async step that led here; a person who changed meanwhile starts nothing. Resolves `null` once the server holds the upload, else why not. */
  async function start(input: { file: File; probe: Mp4Probe; cautions: string[]; target: Parameters<typeof startVideoUpload>[0]["target"] }, generation = uploadIdentityGeneration()): Promise<string | null> {
    if (!userId) return SIGN_IN_AGAIN;
    const started = startVideoUpload({ userId, queryClient, projectId, role, identityGeneration: generation, ...input });
    return started ? await started.reserved : SIGN_IN_AGAIN;
  }

  async function versionFile(video: VideoDto, file: File): Promise<string | null> {
    if (!userId) return SIGN_IN_AGAIN;
    const generation = uploadIdentityGeneration();
    const result = await checkVideoFile(file);
    if (!result.ok) return result.message;
    if (generation !== uploadIdentityGeneration()) return SIGN_IN_AGAIN;
    return await start({ file, probe: result.probe, cautions: result.cautions, target: { kind: "version", videoId: video.id, title: video.title } }, generation);
  }

  const myVersionUpload = (video: VideoDto) => running.find((upload) => upload.videoId === video.id);

  return <section aria-labelledby="video-films-heading" data-testid="video-films">
    <div className="workspace-intro" data-testid="video-films-header">
      <div><div className="ey">Video review</div><h1 className="serif" id="video-films-heading">Films</h1></div>
      <div className="muted">Upload web-ready H.264 MP4 cuts. A re-cut becomes a new version of the same film; notes stay with the version they were made on.</div>
      <ReviewLinksOpenButton ui={reviewLinks} />
    </div>
    <div className="grid gap-[var(--space-5)] p-[var(--space-6)]" data-testid="video-collection-body">
      <ReviewLinksHost ui={reviewLinks} videos={videos.data ?? []} {...(setBarHeight ? { onBarHeight: setBarHeight } : {})} />
      {canUpload && <NewFilmUploader onStart={({ title, ...picked }) => start({ ...picked, target: { kind: "new", title } })} />}
      <EmbeddedUploadTray uploads={rows} errors={[]} onCancel={(key) => void cancelVideoUpload(key, queryClient)} onRemove={(key) => removeVideoUpload(key)} onRetry={(key) => retryVideoUpload(key)} testId="video-upload-tray" />
      {videos.isError && !videos.data && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{videos.error.message || "Films could not be loaded."}</span><Button type="button" variant="text" onClick={() => { terminate(videos.error); void videos.refetch(); }}>Retry</Button></Notice>}
      {videos.data && videos.data.length === 0 && <EmptyState title="No films yet.">{canUpload ? "Drop the first MP4 above to begin." : "Uploaded films will appear here."}</EmptyState>}
      {videos.data && videos.data.length > 0 && <div className="grid gap-[var(--space-5)] [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]" data-testid="video-card-grid" onFocusCapture={() => { preloadViewer(); if (notesEnabled) preloadNotes(); }} onPointerOverCapture={() => { preloadViewer(); if (notesEnabled) preloadNotes(); }}>
        {videos.data.map((video) => <VideoCard key={video.id} video={video} canUpload={canUpload} currentUserId={userId} myUpload={myVersionUpload(video)} onVersionFile={versionFile} onCancelReservation={(reservationId) => abortVideoReservation(queryClient, projectId, reservationId)} onOpen={(picked, trigger) => { opener.current = trigger; setOpenVideoId(picked.id); }} {...(reviewLinks.enabled ? { reviewLinks: { selected: reviewLinks.selection.has(video.id), ...(reviewLinks.canWrite ? { onToggle: () => reviewLinks.store.toggleSelect(video.id) } : {}), chips: reviewLinks.chipsFor(video.id), onOpenChip: reviewLinks.store.openDetail, onOpenAll: reviewLinks.store.openList } } : {})} />)}
      </div>}
    </div>
    {openVideo && <ViewLoadBoundary viewLabel="video player">
      <Suspense fallback={null}>
        <Viewer video={openVideo} onClose={() => setOpenVideoId(null)} returnFocusTo={() => opener.current} {...(notesEnabled ? { notes: { projectId, role, userId, archived, forms, markup: markupEnabled } } : {})} />
      </Suspense>
    </ViewLoadBoundary>}
  </section>;
}
