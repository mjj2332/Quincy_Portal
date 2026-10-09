import { useMemo } from "react";
import type { Mp4Probe, Role, VideoDto, VideoReviewResponse } from "@quincy/shared";
import { useSession } from "../../lib/auth";
import { useOptionalProjectQueryClient, useProjectAccessTermination, useProjectVideosQuery } from "../../lib/project-data";
import { VIDEO_CLIENT_MAX_ACTIVE, cancelVideoUpload, removeVideoUpload, retryVideoUpload, startVideoUpload, useVideoUploads } from "../../lib/video-upload-store";
import { checkVideoFile } from "../../lib/video-upload";
import { Button } from "../quincy/Button";
import { EmbeddedUploadTray, type EmbeddedUpload } from "../quincy/EmbeddedUploadTray";
import { EmptyState } from "../quincy/EmptyState";
import { Notice } from "../quincy/Notice";
import { NewFilmUploader } from "./NewFilmUploader";
import { VideoCard } from "./VideoCard";

/** The Films section of the Video tab (#741 4d-i): upload, my running uploads, and a card per Video. Rendered only when the gate is open. */
export function VideoCollectionPanel({ projectId, role, review }: { projectId: string; role: Role; review: VideoReviewResponse }) {
  const session = useSession();
  const userId = session.data?.user.id ?? null;
  const queryClient = useOptionalProjectQueryClient();
  const terminate = useProjectAccessTermination();
  const videos = useProjectVideosQuery(projectId, true, role, userId ?? undefined);
  const uploads = useVideoUploads(userId, projectId);
  const canUpload = review.parts.includes("upload");
  const running = uploads.filter((upload) => upload.phase === "reserving" || upload.phase === "uploading" || upload.phase === "finishing");
  const atUploadCap = running.length >= VIDEO_CLIENT_MAX_ACTIVE;

  const rows = useMemo<EmbeddedUpload[]>(() => uploads.map((upload) => ({
    key: upload.id,
    name: upload.fileName,
    percent: upload.percent,
    kind: "video",
    phase: upload.phase === "failed" ? "failed" : upload.phase === "finishing" ? "finishing" : "uploading",
    ...(upload.phase === "failed" ? { message: upload.error ?? "The upload failed.", noRetry: upload.retry === null, retryLabel: upload.retry === "finish" ? "Retry finishing" : "Retry" } : {}),
    cautions: upload.cautions,
  })), [uploads]);

  function start(input: { file: File; probe: Mp4Probe; cautions: string[]; target: Parameters<typeof startVideoUpload>[0]["target"] }) {
    if (!userId) return;
    startVideoUpload({ userId, queryClient, projectId, role, ...input });
  }

  async function versionFile(video: VideoDto, file: File): Promise<string | null> {
    if (!userId) return "Sign in again to upload.";
    const result = await checkVideoFile(file);
    if (!result.ok) return result.message;
    start({ file, probe: result.probe, cautions: result.cautions, target: { kind: "version", videoId: video.id, title: video.title } });
    return null;
  }

  const myVersionUpload = (video: VideoDto) => running.find((upload) => upload.videoId === video.id);

  return <section aria-labelledby="video-films-heading" data-testid="video-films">
    <div className="workspace-intro">
      <div><div className="ey">Video review</div><h1 className="serif" id="video-films-heading">Films</h1></div>
      <div className="muted">Upload web-ready H.264 MP4 cuts. A re-cut becomes a new version of the same film; notes stay with the version they were made on.</div>
    </div>
    <div className="grid gap-[var(--space-5)] p-[var(--space-6)]">
      {canUpload && <NewFilmUploader atUploadCap={atUploadCap} onStart={({ title, ...picked }) => start({ ...picked, target: { kind: "new", title } })} />}
      <EmbeddedUploadTray uploads={rows} errors={[]} onCancel={(key) => cancelVideoUpload(key)} onRemove={(key) => removeVideoUpload(key)} onRetry={(key) => retryVideoUpload(key)} testId="video-upload-tray" />
      {videos.isError && !videos.data && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{videos.error.message || "Films could not be loaded."}</span><Button type="button" variant="text" onClick={() => { terminate(videos.error); void videos.refetch(); }}>Retry</Button></Notice>}
      {videos.data && videos.data.length === 0 && <EmptyState title="No films yet.">{canUpload ? "Drop the first MP4 above to begin." : "Uploaded films will appear here."}</EmptyState>}
      {videos.data && videos.data.length > 0 && <div className="grid gap-[var(--space-5)] [grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]" data-testid="video-card-grid">
        {videos.data.map((video) => <VideoCard key={video.id} video={video} canUpload={canUpload} atUploadCap={atUploadCap} myUpload={myVersionUpload(video)} onVersionFile={versionFile} />)}
      </div>}
    </div>
  </section>;
}
