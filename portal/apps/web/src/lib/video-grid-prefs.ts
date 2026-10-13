import type { VideoDto, VideoReviewStatus } from "@quincy/shared";
import { uiPrefKey } from "./ui-prefs";

/**
 * The Video collection's grid preferences (#865): card size, thumbnail fit, whether the card info shows, the sort and the Review status filter.
 * One JSON object per person in this browser (`quincy:ui:video-grid:<userId>`, via `useUiPref`). Sort and filter are client-side over the
 * loaded collection; `arrangeVideos` never mutates the query data.
 */
export type VideoGridSize = "S" | "M" | "L";
export type VideoGridSort = "uploaded" | "name" | "status";
export type VideoGridPrefs = {
  size: VideoGridSize;
  thumb: "fit" | "fill";
  info: boolean;
  sort: VideoGridSort;
  dir: "asc" | "desc";
  status: "all" | VideoReviewStatus;
};

export const DEFAULT_VIDEO_GRID_PREFS: VideoGridPrefs = { size: "M", thumb: "fit", info: true, sort: "uploaded", dir: "desc", status: "all" };

export const videoGridKey = (userId: string): string => uiPrefKey(`video-grid:${userId}`);

const pick = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T => (allowed as readonly unknown[]).includes(raw) ? raw as T : fallback;

/** Module level (stable for `useUiPref`). Field by field: junk in one field keeps the others. */
export function normalizeVideoGridPrefs(raw: unknown): VideoGridPrefs {
  const d = DEFAULT_VIDEO_GRID_PREFS;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    size: pick(o.size, ["S", "M", "L"], d.size),
    thumb: pick(o.thumb, ["fit", "fill"], d.thumb),
    info: typeof o.info === "boolean" ? o.info : d.info,
    sort: pick(o.sort, ["uploaded", "name", "status"], d.sort),
    dir: pick(o.dir, ["asc", "desc"], d.dir),
    status: pick(o.status, ["all", "in_review", "approved_internal", "published"], d.status),
  };
}

/** Literal classes (the Tailwind literal-class guard): S 240, M 320 (the size before this toolbar), L 480 minimum px. */
export const GRID_COLUMNS: Record<VideoGridSize, string> = {
  S: "[grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr))]",
  M: "[grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))]",
  L: "[grid-template-columns:repeat(auto-fill,minmax(min(480px,100%),1fr))]",
};

const STATUS_ORDER: Record<VideoReviewStatus, number> = { in_review: 0, approved_internal: 1, published: 2 };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** The date the card shows: the latest live Version's upload. */
const uploadedAt = (video: VideoDto): string => (video.versions.find((version) => version.current) ?? video.versions[0]!).createdAt;

/** Filter, then a stable sort. `dir` flips the chosen key only; ties always fall to newest upload, then id. */
export function arrangeVideos(videos: readonly VideoDto[], prefs: VideoGridPrefs): VideoDto[] {
  const shown = prefs.status === "all" ? [...videos] : videos.filter((video) => video.reviewStatus === prefs.status);
  const sign = prefs.dir === "asc" ? 1 : -1;
  const tie = (a: VideoDto, b: VideoDto) => uploadedAt(b).localeCompare(uploadedAt(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return shown.sort((a, b) => {
    const primary = prefs.sort === "uploaded" ? uploadedAt(a).localeCompare(uploadedAt(b))
      : prefs.sort === "name" ? collator.compare(a.title, b.title)
        : STATUS_ORDER[a.reviewStatus] - STATUS_ORDER[b.reviewStatus];
    if (prefs.sort === "uploaded") return primary === 0 ? (a.id < b.id ? -1 : 1) : sign * primary;
    return primary !== 0 ? sign * primary : tie(a, b);
  });
}
