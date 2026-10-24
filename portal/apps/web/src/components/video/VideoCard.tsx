import type { VideoDto } from "@quincy/shared";
import { VideoTile, type VideoTileStatus } from "../quincy/VideoTile";
import type { VideoUploadState } from "../../lib/video-upload";
import { useVersionFile, type VersionFileStore } from "../../lib/version-file-state";
import { REVIEW_STATUS_LABEL, REVIEW_STATUS_SHORT, REVIEW_STATUS_TONE } from "./VideoReviewStatusPill";
import { hasActiveLink, VideoCardMenu, videoUploadFacts, videoUploadLine, type VideoActions } from "./VideoCardParts";

export { VIDEO_ACCEPT } from "./VideoCardParts";

/**
 * What a Video's tile and its Video row (#938) both draw, worked out once so the two cannot drift: the newest live Version (its poster, number, duration, upload date and
 * uploader), the next Version's number, and the Review status as the tile and row show it.
 */
export function videoCardFacts(video: VideoDto): { newest: VideoDto["versions"][number]; nextNumber: number; status: VideoTileStatus } {
  return {
    newest: video.versions.find((version) => version.current) ?? video.versions[0]!,
    nextNumber: Math.max(...video.versions.map((version) => version.version)) + 1,
    status: { tone: REVIEW_STATUS_TONE[video.reviewStatus], short: REVIEW_STATUS_SHORT[video.reviewStatus], full: `${REVIEW_STATUS_LABEL[video.reviewStatus]}${video.olderPublishedVersion !== null ? `, v${video.olderPublishedVersion} published` : ""}` },
  };
}

/**
 * One Video as a poster-first tile (#884, was the #741 4d-i card). The whole tile opens the review; "⋯" is its only button and holds everything the card's buttons did. Dropping a file on the poster
 * uploads it as the next Version. The menu, the upload line and the file's check state are the Video row's too (`VideoCardParts`, `createVersionFileState`, #939).
 */
export function VideoCard({ video, canUpload, currentUserId, myUpload, versionFiles, onVersionFile, onCancelReservation, onOpen, ...actions }: {
  video: VideoDto;
  canUpload: boolean;
  currentUserId: string | null;
  /** My running upload of a new Version of this Video in this tab, if any. */
  myUpload?: VideoUploadState;
  /** The panel's per-film check state for a file offered as the next Version. */
  versionFiles: VersionFileStore;
  /** Checks a file offered as the next Version and starts its upload, through `versionFiles`. */
  onVersionFile: (video: VideoDto, file: File) => void;
  /** Asks the server to drop an upload this tab has no job for. */
  onCancelReservation: (reservationId: string) => Promise<void>;
  /** Opens the review player on this Video, on `version` when given; `trigger` is where focus returns on close. */
  onOpen: (video: VideoDto, trigger: HTMLElement, version?: number) => void;
} & VideoActions) {
  const { checking, message } = useVersionFile(versionFiles, video.id);
  const { newest, nextNumber, status } = videoCardFacts(video);
  const { busy } = videoUploadFacts(video, myUpload, currentUserId);
  const sendFile = (file: File) => { onVersionFile(video, file); };
  const footer = videoUploadLine({ video, myUpload, currentUserId, nextNumber, message, onCancelReservation });

  return <VideoTile
    testId="video-card" openTestId="video-card-open" dataVideoId={video.id}
    title={video.title} posterUrl={newest.posterUrl} version={newest.version} durationMs={newest.durationMs} openNotes={video.latestNoteCount}
    status={status}
    {...(video.premium ? { premium: true } : {})}
    {...(hasActiveLink(actions) ? { linked: true } : {})}
    onOpen={(trigger) => { onOpen(video, trigger); }}
    {...(actions.select ? { select: actions.select } : {})}
    menu={<VideoCardMenu video={video} newestVersion={newest.version} canUploadNow={canUpload && !busy} checking={checking} onFile={sendFile} onOpen={onOpen} actions={actions} />}
    {...(canUpload ? { drop: { nextVersion: nextNumber, disabled: busy || checking, onFile: sendFile } } : {})}
    {...(footer ? { footer } : {})}
  />;
}
