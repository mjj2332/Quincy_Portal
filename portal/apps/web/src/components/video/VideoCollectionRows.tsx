import type { VideoDto } from "@quincy/shared";
import { PHONE_VIEWPORT_QUERY, useMediaQuery } from "../../lib/use-media-query";
import type { VideoUploadState } from "../../lib/video-upload";
import type { VideoGridPrefs, VideoGridSort } from "../../lib/video-grid-prefs";
import { useVersionFiles, IDLE_VERSION_FILE, type VersionFileStore } from "../../lib/version-file-state";
import { VideoRows, type VideoRowColumn, type VideoRowItem, type VideoRowSortKey, type VideoRowsSort } from "../quincy/VideoRows";
import { videoCardFacts } from "./VideoCard";
import { hasActiveLink, VideoCardMenu, videoUploadFacts, videoUploadLine, type VideoActions } from "./VideoCardParts";

const TEST_IDS = { row: "video-row", open: "video-row-open" } as const;
/** The staff column set (#938, #939): the tick column only while the panel grants selection, so a person who cannot select is not given an empty column. */
const COLUMNS: readonly VideoRowColumn[] = ["poster", "title", "status", "notes", "duration", "uploaded", "uploader", "menu"];
const COLUMNS_WITH_TICK: readonly VideoRowColumn[] = ["select", ...COLUMNS];
/** The headers that sort (#939): the Title, Status and Uploaded columns, as the toolbar's Name, Status and Upload date. */
const SORTABLE: readonly VideoRowSortKey[] = ["title", "status", "uploaded"];
const ROW_KEY: Record<VideoGridSort, VideoRowSortKey> = { name: "title", status: "status", uploaded: "uploaded" };
const PREF_KEY: Record<VideoRowSortKey, VideoGridSort> = { title: "name", status: "status", uploaded: "uploaded" };

/**
 * The staff Video tab's list layout (#938): one Video row per arranged film, in the order and under the filter the toolbar chose (`arrangeVideos`, as the tiles), each showing the
 * facts of its newest live Version (`videoCardFacts`, the tile's own). A row opens the review through the same panel callback as a tile, with its open control as the trigger, so
 * closing the viewer returns focus there. On a phone (`PHONE_VIEWPORT_QUERY`, S9) the rows are the compact two-line list, which has no uploader.
 *
 * A row does everything a tile does (#939), with the tile's own pieces: the tick (`actions.select`), the "⋯" menu (`VideoCardMenu`), dropping a file as the next Version, and the
 * upload line under the title (`videoUploadLine`), the file's check state read from the panel's store. The Title, Status and Uploaded headers report a press to `onSort`, which
 * writes the same sort preference as the toolbar.
 */
export function VideoCollectionRows({ videos, onOpen, actionsFor, canUpload, currentUserId, myUploadOf, versionFiles, onVersionFile, onCancelReservation, sort, onSort }: {
  videos: readonly VideoDto[];
  /** Opens the review on `version` (from the "⋯" Versions submenu), else the newest; `trigger` is where focus returns on close. */
  onOpen: (video: VideoDto, trigger: HTMLElement, version?: number) => void;
  /** What the panel grants on each film, as it grants a tile. */
  actionsFor: (video: VideoDto) => VideoActions;
  canUpload: boolean;
  currentUserId: string | null;
  myUploadOf: (video: VideoDto) => VideoUploadState | undefined;
  versionFiles: VersionFileStore;
  onVersionFile: (video: VideoDto, file: File) => void;
  onCancelReservation: (reservationId: string) => Promise<void>;
  sort: Pick<VideoGridPrefs, "sort" | "dir">;
  /** A sortable header was pressed on this key. */
  onSort: (key: VideoGridSort) => void;
}) {
  const compact = useMediaQuery(PHONE_VIEWPORT_QUERY);
  const files = useVersionFiles(versionFiles);
  // Rebuilt on every render: the actions close over the panel's live state (selection, chips), as each tile's props are. The grid keys rows by id, so nothing remounts.
  const items = videos.map((video): VideoRowItem => {
    const actions = actionsFor(video);
    const { newest, nextNumber, status } = videoCardFacts(video);
    const { checking, message } = files.get(video.id) ?? IDLE_VERSION_FILE;
    const myUpload = myUploadOf(video);
    const { busy } = videoUploadFacts(video, myUpload, currentUserId);
    const sendFile = (file: File) => { onVersionFile(video, file); };
    const footer = videoUploadLine({ video, myUpload, currentUserId, nextNumber, message, onCancelReservation });
    return {
      id: video.id, dataVideoId: video.id, title: video.title, posterUrl: newest.posterUrl, version: newest.version, durationMs: newest.durationMs, openNotes: video.latestNoteCount,
      status, uploadedAt: newest.createdAt, uploader: { name: newest.uploadedBy.name },
      ...(video.premium ? { premium: true } : {}),
      ...(hasActiveLink(actions) ? { linked: true } : {}),
      onOpen: (trigger) => { onOpen(video, trigger); },
      ...(actions.select ? { select: actions.select } : {}),
      menu: <VideoCardMenu video={video} newestVersion={newest.version} canUploadNow={canUpload && !busy} checking={checking} onFile={sendFile} onOpen={onOpen} actions={actions} />,
      ...(canUpload ? { drop: { nextVersion: nextNumber, disabled: busy || checking, onFile: sendFile } } : {}),
      ...(footer ? { footer } : {}),
    };
  });
  const withTick = items.some((item) => item.select !== undefined);
  const rowsSort: VideoRowsSort = { key: ROW_KEY[sort.sort], dir: sort.dir, sortable: SORTABLE, onSort: (key) => { onSort(PREF_KEY[key]); } };
  return <VideoRows items={items} columns={withTick ? COLUMNS_WITH_TICK : COLUMNS} compact={compact} label="Films" testIds={TEST_IDS} sort={rowsSort} />;
}
