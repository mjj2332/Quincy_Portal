import { ArrowDownWideNarrow, ArrowUpNarrowWide } from "lucide-react";
import type { VideoReviewStatus } from "@quincy/shared";
import { cn } from "@/lib/utils";
import { Button } from "../quincy/Button";
import { IconButton } from "../quincy/icon-button";
import { Label } from "../reui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../reui/select";
import type { VideoGridPrefs, VideoGridSort } from "../../lib/video-grid-prefs";
import { REVIEW_STATUS_LABEL } from "./VideoReviewStatusPill";

const TOOL = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const BAR = cn(TOOL, "h-8");
const LABEL = "text-foreground-secondary [font:var(--type-label)]";

const SORT_LABEL: Record<VideoGridSort, string> = { uploaded: "Upload date", name: "Name", status: "Review status" };
/** The direction a key reads naturally in when it is first picked. */
const NATURAL_DIR: Record<VideoGridSort, VideoGridPrefs["dir"]> = { uploaded: "desc", name: "asc", status: "asc" };
const DIR_LABEL: Record<VideoGridSort, Record<VideoGridPrefs["dir"], string>> = {
  uploaded: { desc: "Newest first", asc: "Oldest first" },
  name: { asc: "A–Z", desc: "Z–A" },
  status: { asc: "Needs review first", desc: "Published first" },
};
const STATUS_OPTIONS: Array<VideoGridPrefs["status"]> = ["all", "in_review", "approved_internal", "published"];
const statusLabel = (status: VideoGridPrefs["status"]): string => status === "all" ? "All films" : REVIEW_STATUS_LABEL[status as VideoReviewStatus];

/**
 * The Video collection's toolbar (#865; Appearance left with #884's single tile size): Sort (key and direction) and the Review status filter. The behaviour is FreeFrame's
 * sort popover (MIT, see THIRD_PARTY_NOTICES) on ReUI parts. `shown` of `total` is the filter's footprint, so a filter that hides films never hides that it does.
 */
export function VideoGridToolbar({ prefs, onChange, shown, total }: { prefs: VideoGridPrefs; onChange: (next: VideoGridPrefs) => void; shown: number; total: number }) {
  const set = (patch: Partial<VideoGridPrefs>) => onChange({ ...prefs, ...patch });
  const filtered = prefs.status !== "all";
  const DirIcon = prefs.dir === "desc" ? ArrowDownWideNarrow : ArrowUpNarrowWide;
  return <div data-testid="video-grid-toolbar" className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)]">
    <div className="flex items-center gap-[var(--space-2)]">
      <Label htmlFor="video-grid-sort" className={LABEL}>Sort</Label>
      <Select value={prefs.sort} onValueChange={(next) => { if (next === "uploaded" || next === "name" || next === "status") { if (next !== prefs.sort) set({ sort: next, dir: NATURAL_DIR[next] }); } }}>
        <SelectTrigger id="video-grid-sort" data-testid="video-grid-sort" className={cn(BAR, "min-w-36")}>
          <SelectValue>{() => <span className="block truncate">{SORT_LABEL[prefs.sort]}</span>}</SelectValue>
        </SelectTrigger>
        <SelectContent className="w-auto min-w-(--anchor-width)">
          {(Object.keys(SORT_LABEL) as VideoGridSort[]).map((key) => <SelectItem key={key} value={key} className={TOOL}>{SORT_LABEL[key]}</SelectItem>)}
        </SelectContent>
      </Select>
      <IconButton data-testid="video-grid-dir" aria-label={DIR_LABEL[prefs.sort][prefs.dir]} title={DIR_LABEL[prefs.sort][prefs.dir]} onClick={() => { set({ dir: prefs.dir === "asc" ? "desc" : "asc" }); }}><DirIcon aria-hidden="true" className="size-4" /></IconButton>
    </div>

    <div className="flex items-center gap-[var(--space-2)]">
      <Label htmlFor="video-grid-status" className={LABEL}>Status</Label>
      <Select value={prefs.status} onValueChange={(next) => { if (STATUS_OPTIONS.includes(next as VideoGridPrefs["status"])) set({ status: next as VideoGridPrefs["status"] }); }}>
        <SelectTrigger id="video-grid-status" data-testid="video-grid-status" className={cn(BAR, "min-w-40")}>
          <SelectValue>{() => <span className="block truncate">{statusLabel(prefs.status)}</span>}</SelectValue>
        </SelectTrigger>
        <SelectContent className="w-auto min-w-(--anchor-width)">
          {STATUS_OPTIONS.map((status) => <SelectItem key={status} value={status} className={TOOL}>{statusLabel(status)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>

    {filtered && <div className="flex items-center gap-[var(--space-2)]">
      <p role="status" data-testid="video-grid-count" className={LABEL}>{`Showing ${shown} of ${total} films`}</p>
      <Button type="button" variant="text" data-testid="video-grid-show-all" className={TOOL} onClick={() => { set({ status: "all" }); }}>Show all films</Button>
    </div>}
  </div>;
}
