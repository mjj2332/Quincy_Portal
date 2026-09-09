import { useEffect, useMemo, useRef, useState } from "react";
import { DOWNLOAD_SELECTION_MAX_ASSETS, DOWNLOAD_SELECTION_MAX_BYTES } from "@quincy/shared";
import { LabelDot, Stars } from "./atoms";
import { LazyImage } from "./LazyImage";
import { confirm } from "../lib/confirm";
import { cn } from "../lib/utils";
import { buttonClasses } from "./quincy/Button";
import { REVIEW_LABELS as LABELS } from "./lightbox/review-labels";

export type Review = { stars: number | null; colorLabel: "select" | "maybe" | "cut" | "hero" | null; decision: "approved" | "flagged" | null; recommended: boolean };
export type WorkspaceAsset = { id: string; collectionId: string; kind: "photo" | "video" | "floorplan_pdf" | "floorplan_preview" | "copy_pdf"; originalFilename: string; bytes: number; width: number | null; height: number | null; ratingFromMetadata: number | null; section: string | null; renditionStatus: "processing" | "ready"; createdAt: string; sourceRawAssetId: string | null; version: number; versionGroupId: string | null; supersedesAssetId: string | null; review: Review | null; selected: boolean };
export type ReviewPatch = Partial<Pick<Review, "stars" | "colorLabel" | "decision" | "recommended">>;

interface PhotoGridProps {
  assets: WorkspaceAsset[];
  /** RAW review groups root captures and Dropbox subfolders; Edited QA groups AutoHDR vs Manual. */
  showSections: boolean;
  canReview: boolean;
  canRecommend: boolean;
  canSelect: boolean;
  canSetCover: boolean;
  canDelete?: boolean;
  /** Effective cover (stored-if-valid else automatic) — drives the "Cover" tag. */
  coverAssetId: string | null;
  /** Explicitly stored cover — its tile's button clears instead of sets. */
  storedCoverAssetId: string | null;
  onSetCover: (assetId: string | null) => Promise<void>;
  onOpen: (asset: WorkspaceAsset, orderedAssets: WorkspaceAsset[]) => void;
  onReview: (assetId: string, patch: ReviewPatch) => Promise<void>;
  onSelection: (assetId: string, selected: boolean) => Promise<void>;
  onDelete?: (assetId: string) => Promise<void>;
  onBulkDelete?: (assetIds: string[]) => Promise<{ succeededIds: string[]; failedIds: string[] }>;
  canDownloadSelection?: boolean;
  onDownloadSelection?: (assetIds: string[]) => Promise<void>;
}

// TB8-09 slice 5, owner decision §9.3 (approved 2026-09-04): `.actionbar` takes the inverse
// scope and `.barbtn`/`.barbtn--solid` retire onto `buttonClasses`. Class names stay as
// non-styling hooks -- `PhotoGrid.dom.test.tsx` has nine `.actionbar .barbtn` queries.
const ACTIONBAR =
  "fixed left-1/2 bottom-[24px] -translate-x-1/2 z-[60] flex items-center " +
  "gap-[var(--space-4)] py-[10px] pr-[12px] pl-[20px] rounded-[var(--radius-pill)] " +
  "shadow-[var(--shadow-lg)] bg-background text-foreground";
const BARBTN = buttonClasses("secondary");
const BARBTN_SOLID = buttonClasses("primary");

function rating(asset: WorkspaceAsset) { return asset.review?.stars ?? asset.ratingFromMetadata ?? 0; }
function labelName(value: Review["colorLabel"]) { return LABELS.find((label) => label.value === value)?.name ?? ""; }
export function groupWorkspaceAssetsBySection(assets: WorkspaceAsset[]) {
  const captures: WorkspaceAsset[] = [];
  const sections = new Map<string, WorkspaceAsset[]>();
  for (const asset of assets) {
    if (asset.section === null) { captures.push(asset); continue; }
    const sectionAssets = sections.get(asset.section);
    if (sectionAssets) sectionAssets.push(asset); else sections.set(asset.section, [asset]);
  }
  const groups = [...sections.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: "base" }) || left.localeCompare(right))
    .map(([section, sectionAssets]) => ({ section, label: section, assets: sectionAssets }));
  return captures.length ? [{ section: null, label: "Captures", assets: captures }, ...groups] : groups;
}
export function workspaceSectionKey(section: string | null) { return section === null ? "workspace-section:root" : `workspace-section:folder:${section}`; }
export function workspaceAssetIdsBetween(assets: WorkspaceAsset[], firstId: string, lastId: string) {
  const first = assets.findIndex((asset) => asset.id === firstId);
  const last = assets.findIndex((asset) => asset.id === lastId);
  if (first < 0 || last < 0) return [];
  return assets.slice(Math.min(first, last), Math.max(first, last) + 1).map((asset) => asset.id);
}
export function updateFailedThumbnailState(current: Set<string>, assetId: string, failed: boolean): Set<string> {
  if (failed === current.has(assetId)) return current;
  const next = new Set(current);
  if (failed) next.add(assetId); else next.delete(assetId);
  return next;
}

export function PhotoGrid({ assets, showSections, canReview, canRecommend, canSelect, canSetCover, canDelete = false, coverAssetId, storedCoverAssetId, onSetCover, onOpen, onReview, onSelection, onDelete, onBulkDelete, canDownloadSelection = false, onDownloadSelection }: PhotoGridProps) {
  const [filter, setFilter] = useState("all");
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const [failedThumbnails, setFailedThumbnails] = useState<Set<string>>(new Set());
  const [thumbnailRetries, setThumbnailRetries] = useState<Record<string, number>>({});
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);
  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    const ids = new Set(assets.map((asset) => asset.id));
    setMulti((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [assets]);
  const visible = useMemo(() => assets.filter((asset) => {
    if (filter === "recommended") return asset.review?.recommended;
    if (filter === "rated") return rating(asset) > 0;
    if (filter === "labeled") return Boolean(asset.review?.colorLabel);
    if (filter === "selected") return asset.selected;
    return true;
  }), [assets, filter]);
  const sectionGroups = useMemo(() => groupWorkspaceAssetsBySection(visible), [visible]);
  const bytesById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.bytes])), [assets]);
  const displayOrder = showSections ? sectionGroups.flatMap((group) => group.assets) : visible;
  const filters = [
    { id: "all", label: "All" },
    ...(canRecommend ? [{ id: "recommended", label: "Recommended" }] : []),
    { id: "rated", label: "Rated" },
    { id: "labeled", label: "Labeled" },
    ...(canSelect ? [{ id: "selected", label: "For editing" }] : []),
  ];

  function toggleMulti(asset: WorkspaceAsset, shifted: boolean) {
    // Capture the anchor before calling setMulti, not inside the updater: React can defer
    // invoking a functional updater until after this function's remaining synchronous code
    // (including the lastSelected.current write below) has already run, so reading the ref
    // from inside the updater can see this call's own asset.id instead of the real prior
    // anchor, silently turning a shift-click range-select into a same-item no-op.
    const anchor = lastSelected.current;
    setMulti((current) => {
      const next = new Set(current);
      if (shifted && anchor !== null) {
        for (const id of workspaceAssetIdsBetween(displayOrder, anchor, asset.id)) next.add(id);
      } else if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id);
      return next;
    });
    lastSelected.current = asset.id;
  }
  const allVisibleSelected = displayOrder.length > 0 && displayOrder.every((asset) => multi.has(asset.id));
  function selectAll() {
    setMulti((current) => new Set([...current, ...displayOrder.map((asset) => asset.id)]));
    lastSelected.current = null;
  }
  function deselectAll() {
    setMulti((current) => { const next = new Set(current); for (const asset of displayOrder) next.delete(asset.id); return next; });
    lastSelected.current = null;
  }
  function retryThumbnail(assetId: string) {
    setFailedThumbnails((current) => { const next = new Set(current); next.delete(assetId); return next; });
    setThumbnailRetries((current) => ({ ...current, [assetId]: (current[assetId] ?? 0) + 1 }));
  }
  async function bulk(action: "approve" | "flag" | "recommend" | "select" | "rate" | "label") {
    const ids = [...multi];
    const patch = action === "approve" ? { decision: "approved" as const } : action === "flag" ? { decision: "flagged" as const } : action === "recommend" ? { recommended: true } : action === "rate" ? { stars: 5 } : { colorLabel: "select" as const };
    await Promise.all(ids.map((id) => action === "select" ? onSelection(id, true) : onReview(id, patch)));
    setMulti(new Set());
    lastSelected.current = null;
  }
  async function deleteOne(asset: WorkspaceAsset) {
    if (!onDelete || !await confirm({ title: `Delete ${asset.originalFilename}?`, message: `Permanently delete ${asset.originalFilename}? This cannot be undone.`, confirmLabel: "Delete", danger: true })) return;
    await onDelete(asset.id);
    setMulti((current) => { if (!current.has(asset.id)) return current; const next = new Set(current); next.delete(asset.id); return next; });
    lastSelected.current = null;
  }
  async function deleteMany() {
    if (!onBulkDelete) return;
    const ids = [...multi];
    if (!await confirm({ title: `Delete ${ids.length} selected asset${ids.length === 1 ? "" : "s"}?`, message: `Permanently delete ${ids.length} selected asset${ids.length === 1 ? "" : "s"}? This cannot be undone.`, confirmLabel: "Delete selected", danger: true })) return;
    const result = await onBulkDelete(ids);
    const succeeded = new Set(result.succeededIds);
    setMulti((current) => { const next = new Set([...current].filter((id) => !succeeded.has(id))); return next.size === current.size ? current : next; });
    lastSelected.current = null;
  }
  async function downloadSelection() {
    if (!onDownloadSelection) return;
    const ids = [...multi];
    setIsPreparingDownload(true);
    try { await onDownloadSelection(ids); }
    finally { setIsPreparingDownload(false); }
  }
  function renderGrid(gridAssets: WorkspaceAsset[]) {
    return <div className="legacy-grid workspace-photo-grid">{gridAssets.map((asset) => {
      const review = asset.review;
      const marked = multi.has(asset.id);
      const state = review?.decision;
      const previewPending = asset.renditionStatus === "processing";
      const activate = () => previewPending ? undefined : failedThumbnails.has(asset.id) ? retryThumbnail(asset.id) : onOpen(asset, displayOrder);
      return <div className={`tile ${marked ? "is-selected" : ""} ${state ? `st-${state}` : ""} ${rating(asset) ? "has-rating" : ""} ${asset.selected ? "has-state" : ""}`} data-testid="photo-grid-tile" data-multi-selected={marked ? "true" : undefined} key={asset.id} role="button" tabIndex={previewPending ? -1 : 0} aria-disabled={previewPending || undefined} aria-label={previewPending ? `${asset.originalFilename} is processing` : failedThumbnails.has(asset.id) ? `Retry thumbnail for ${asset.originalFilename}` : undefined} onClick={activate} onKeyDown={(event) => { if (!previewPending && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); activate(); } }}>
        {previewPending ? <div className="project-cover-placeholder lazy-image-placeholder" role="status" aria-label={`Processing preview for ${asset.originalFilename}`}><span>Processing preview…</span></div> : <LazyImage preload="background" assetId={asset.id} alt={asset.originalFilename} retryToken={thumbnailRetries[asset.id]} onFailedChange={(failed) => setFailedThumbnails((current) => updateFailedThumbnailState(current, asset.id, failed))} />}<div className="tile__scrim" />
        <button className="selbox" type="button" aria-label={`Select ${asset.originalFilename}`} onClick={(event) => { event.stopPropagation(); toggleMulti(asset, event.shiftKey); }}>✓</button>
        <span className="tile__num">{asset.originalFilename}</span>
        {review?.colorLabel && <span style={{ position: "absolute", top: 13, left: 42, zIndex: 4 }}><LabelDot color={LABELS.find((item) => item.value === review.colorLabel)?.color ?? "#fff"} name={labelName(review.colorLabel)} /></span>}
        <div className="tile__tools">
          {canReview && <><button className="icbtn icbtn--ondark" type="button" title="Approve" onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { decision: state === "approved" ? null : "approved" }); }}>✓</button><button className="icbtn icbtn--ondark" type="button" title="Flag" onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { decision: state === "flagged" ? null : "flagged" }); }}>⚑</button></>}
          {canRecommend && <button className="icbtn icbtn--ondark" type="button" title="Recommend" onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { recommended: !review?.recommended }); }}>★</button>}
          {canSelect && <button className="icbtn icbtn--ondark" type="button" title="Select for editing" onClick={(event) => { event.stopPropagation(); void onSelection(asset.id, !asset.selected); }}>↗</button>}
          {canSetCover && <button className="icbtn icbtn--ondark" type="button" title={storedCoverAssetId === asset.id ? "Remove as cover (use first RAW frame)" : "Use as project cover"} onClick={(event) => { event.stopPropagation(); void onSetCover(storedCoverAssetId === asset.id ? null : asset.id); }}>◈</button>}
          {canDelete && onDelete && <button className="icbtn icbtn--ondark" type="button" title="Delete asset" aria-label={`Delete ${asset.originalFilename}`} onClick={(event) => { event.stopPropagation(); void deleteOne(asset).catch(() => undefined); }}>×</button>}
        </div>
        <div className="statetags">
          {asset.selected && <span className="statetag st-editing">For editing</span>}
          {previewPending && <span className="statetag st-editing">Processing preview</span>}
          {coverAssetId === asset.id && <span className="statetag">Cover</span>}
          {review?.recommended && !asset.selected && <span className="statetag">Recommended</span>}
          {state && <span className={`statetag st-${state}`}>{state === "approved" ? "Approved" : "Flagged"}</span>}
        </div>
        <Stars value={rating(asset)} />
      </div>;
    })}</div>;
  }

  return <>
    <div className="worktools"><div className="filter-chips">{filters.map((item) => <button type="button" className={`chip ${filter === item.id ? "is-active" : ""}`} data-testid="photo-grid-filter" data-active={filter === item.id ? "true" : undefined} key={item.id} onClick={() => setFilter(item.id)}>{item.label}<span className="cnt">{item.id === "all" ? assets.length : assets.filter((asset) => item.id === "recommended" ? asset.review?.recommended : item.id === "rated" ? rating(asset) > 0 : item.id === "labeled" ? Boolean(asset.review?.colorLabel) : asset.selected).length}</span></button>)}{displayOrder.length > 0 && <button type="button" className={`chip ${allVisibleSelected ? "is-active" : ""}`} data-testid="photo-grid-filter" data-active={allVisibleSelected ? "true" : undefined} onClick={allVisibleSelected ? deselectAll : selectAll}>{allVisibleSelected ? "Deselect all" : "Select all"}</button>}</div><div className="grow" /><span className="prog">{assets.length} frames</span></div>
    <div className="workgrid">
      {visible.length === 0 ? <div className="empty"><span className="serif">No frames in this view.</span>Choose another filter or upload the capture set.</div> : showSections ? sectionGroups.map((group, index) => <section className="workspace-section" key={workspaceSectionKey(group.section)}><div className="ey" style={{ margin: index === 0 ? "4px 0 10px" : "22px 0 10px" }}>{group.label}</div>{renderGrid(group.assets)}</section>) : renderGrid(visible)}
    </div>
    {multi.size > 0 && <div className={ACTIONBAR} data-surface="inverse" data-testid="photo-grid-actionbar"><span className="[font:400_18px/1.18_var(--font-display)]">{multi.size}</span><span className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-on-inverse-muted">selected</span><span className="w-px h-[22px] bg-border" />{canReview && <><button className={BARBTN} type="button" onClick={() => void bulk("rate")}>Rate 5</button><button className={BARBTN} type="button" onClick={() => void bulk("label")}>Label</button><button className={BARBTN_SOLID} type="button" onClick={() => void bulk("approve")}>Approve</button><button className={BARBTN} type="button" onClick={() => void bulk("flag")}>Flag</button></>}{canRecommend && <button className={BARBTN_SOLID} type="button" onClick={() => void bulk("recommend")}>Recommend</button>}{canSelect && <button className={BARBTN} type="button" onClick={() => void bulk("select")}>Select for editing</button>}{canDelete && onBulkDelete && <button className={BARBTN} type="button" onClick={() => void deleteMany().catch(() => undefined)}>Delete {multi.size}</button>}<button className={BARBTN} type="button" onClick={() => { setMulti(new Set()); lastSelected.current = null; }}>Clear</button>{canDownloadSelection && onDownloadSelection && (() => {
      const totalBytes = [...multi].reduce((total, id) => total + (bytesById.get(id) ?? 0), 0);
      const exceedsLimit = multi.size > DOWNLOAD_SELECTION_MAX_ASSETS || totalBytes > DOWNLOAD_SELECTION_MAX_BYTES;
      const maxMiB = Math.floor(DOWNLOAD_SELECTION_MAX_BYTES / (1024 * 1024));
      return <button className={BARBTN} type="button" disabled={isPreparingDownload || exceedsLimit} title={exceedsLimit ? `Download up to ${DOWNLOAD_SELECTION_MAX_ASSETS} assets / ${maxMiB} MiB` : undefined} onClick={() => void downloadSelection().catch(() => undefined)}>{isPreparingDownload ? "Preparing download…" : "Download selection"}</button>;
    })()}</div>}
  </>;
}
