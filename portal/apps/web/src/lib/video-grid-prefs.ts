import type { VideoDto, VideoReviewStatus } from "@quincy/shared";
import { uiPrefKey } from "./ui-prefs";
import { normalizeVideoLayout, type VideoLayout } from "./video-layout-pref";

/**
 * The Video collection's grid preferences (#865, trimmed by #884: the tile has one size and one poster fit, so Appearance is gone): the sort, the Review status filter and (#938) the layout.
 * One JSON object per person in this browser (`quincy:ui:video-grid:<userId>`, via `useUiPref`). Sort and filter are client-side over the
 * loaded collection; `arrangeVideos` never mutates the query data.
 */
export type VideoGridSort = "uploaded" | "name" | "status";
export type VideoGridPrefs = {
  sort: VideoGridSort;
  dir: "asc" | "desc";
  status: "all" | VideoReviewStatus;
  /** Tiles or Video rows (#938); presentation only, the sort and filter apply to both. */
  layout: VideoLayout;
};

export const DEFAULT_VIDEO_GRID_PREFS: VideoGridPrefs = { sort: "uploaded", dir: "desc", status: "all", layout: "tiles" };

/** The direction a key reads naturally in when it is first picked, from the toolbar's Sort or (#939) a column header. */
export const NATURAL_DIR: Record<VideoGridSort, VideoGridPrefs["dir"]> = { uploaded: "desc", name: "asc", status: "asc" };

/**
 * A Video row's column header pressed (#939, S13): another key is picked in its natural direction (as the toolbar picks it); the current key flips. Never cleared: the
 * grid's third, clearing press on a header is a press on the current key and flips it too. The filter and the layout stay; `arrangeVideos` stays the only sorter.
 */
export function headerSort(prefs: VideoGridPrefs, key: VideoGridSort): VideoGridPrefs {
  return key === prefs.sort ? { ...prefs, dir: prefs.dir === "asc" ? "desc" : "asc" } : { ...prefs, sort: key, dir: NATURAL_DIR[key] };
}

export const videoGridKey =(userId: string): string => uiPrefKey(`video-grid:${userId}`);

const pick = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T => (allowed as readonly unknown[]).includes(raw) ? raw as T : fallback;

/** Module level (stable for `useUiPref`). Field by field: junk in one field keeps the others; the old `size`, `thumb` and `info` keys are ignored. */
export function normalizeVideoGridPrefs(raw: unknown): VideoGridPrefs {
  const d = DEFAULT_VIDEO_GRID_PREFS;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    sort: pick(o.sort, ["uploaded", "name", "status"], d.sort),
    dir: pick(o.dir, ["asc", "desc"], d.dir),
    status: pick(o.status, ["all", "in_review", "approved_internal", "published"], d.status),
    layout: normalizeVideoLayout(o.layout),
  };
}

/** D26: as many columns as fit, each tile at least 280px; one column on a phone. A literal class (the Tailwind literal-class guard). */
export const GRID_CLASS = "[grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr))] max-[721px]:grid-cols-1";

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
