import { useMemo } from "react";
import type { VideoDto } from "@quincy/shared";
import { PHONE_VIEWPORT_QUERY, useMediaQuery } from "../../lib/use-media-query";
import { VideoRows, type VideoRowColumn, type VideoRowItem } from "../quincy/VideoRows";
import { videoCardFacts } from "./VideoCard";

/** The staff column set (#938). The tick and "⋯" columns join with the row actions (#939). */
const STAFF_COLUMNS: readonly VideoRowColumn[] = ["poster", "title", "status", "notes", "duration", "uploaded", "uploader"];
const TEST_IDS = { row: "video-row", open: "video-row-open" } as const;

/**
 * The staff Video tab's list layout (#938): one Video row per arranged film, in the order and under the filter the toolbar chose (`arrangeVideos`, as the tiles), each showing the
 * facts of its newest live Version (`videoCardFacts`, the tile's own). A row opens the review through the same panel callback as a tile, with its open control as the trigger, so
 * closing the viewer returns focus there. On a phone (`PHONE_VIEWPORT_QUERY`, S9) the rows are the compact two-line list, which has no uploader.
 */
export function VideoCollectionRows({ videos, onOpen, isLinked }: {
  videos: readonly VideoDto[];
  onOpen: (video: VideoDto, trigger: HTMLElement) => void;
  /** Whether the film is on an active Review link; absent while Review links are off. */
  isLinked?: (videoId: string) => boolean;
}) {
  const compact = useMediaQuery(PHONE_VIEWPORT_QUERY);
  const items = useMemo(() => videos.map((video): VideoRowItem => {
    const { newest, status } = videoCardFacts(video);
    return {
      id: video.id, dataVideoId: video.id, title: video.title, posterUrl: newest.posterUrl, version: newest.version, durationMs: newest.durationMs, openNotes: video.latestNoteCount,
      status, uploadedAt: newest.createdAt, uploader: { name: newest.uploadedBy.name },
      ...(video.premium ? { premium: true } : {}),
      ...(isLinked?.(video.id) ? { linked: true } : {}),
      onOpen: (trigger) => { onOpen(video, trigger); },
    };
  }), [videos, onOpen, isLinked]);
  return <VideoRows items={items} columns={STAFF_COLUMNS} compact={compact} label="Films" testIds={TEST_IDS} />;
}
