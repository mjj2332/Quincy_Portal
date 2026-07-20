import { useMemo, useRef, useState, type CSSProperties } from "react";
import { LabelDot, Stars } from "./atoms";

export type Review = { stars: number | null; colorLabel: "select" | "maybe" | "cut" | "hero" | null; decision: "approved" | "flagged" | null; recommended: boolean };
export type WorkspaceAsset = { id: string; collectionId: string; originalFilename: string; bytes: number; width: number | null; height: number | null; ratingFromMetadata: number | null; isPremium: boolean; createdAt: string; sourceRawAssetId: string | null; review: Review | null; selected: boolean };
export type ReviewPatch = Partial<Pick<Review, "stars" | "colorLabel" | "decision" | "recommended">>;

const LABELS: { value: NonNullable<Review["colorLabel"]>; name: string; color: string }[] = [
  { value: "hero", name: "Hero", color: "#9a6a1f" }, { value: "select", name: "Select", color: "#3f5b3a" }, { value: "maybe", name: "Maybe", color: "#2f3b4d" }, { value: "cut", name: "Cut", color: "#7a2420" },
];

interface PhotoGridProps {
  assets: WorkspaceAsset[];
  canReview: boolean;
  canRecommend: boolean;
  canSelect: boolean;
  canSetCover: boolean;
  /** Effective cover (stored-if-valid else automatic) — drives the "Cover" tag. */
  coverAssetId: string | null;
  /** Explicitly stored cover — its tile's button clears instead of sets. */
  storedCoverAssetId: string | null;
  onSetCover: (assetId: string | null) => Promise<void>;
  onOpen: (asset: WorkspaceAsset, orderedAssets: WorkspaceAsset[]) => void;
  onReview: (assetId: string, patch: ReviewPatch) => Promise<void>;
  onSelection: (assetId: string, selected: boolean) => Promise<void>;
}

function rating(asset: WorkspaceAsset) { return asset.review?.stars ?? asset.ratingFromMetadata ?? 0; }
function labelName(value: Review["colorLabel"]) { return LABELS.find((label) => label.value === value)?.name ?? ""; }

export function PhotoGrid({ assets, canReview, canRecommend, canSelect, canSetCover, coverAssetId, storedCoverAssetId, onSetCover, onOpen, onReview, onSelection }: PhotoGridProps) {
  const [filter, setFilter] = useState("all");
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const lastSelected = useRef<number | null>(null);
  const visible = useMemo(() => assets.filter((asset) => {
    if (filter === "recommended") return asset.review?.recommended;
    if (filter === "rated") return rating(asset) > 0;
    if (filter === "labeled") return Boolean(asset.review?.colorLabel);
    if (filter === "selected") return asset.selected;
    return true;
  }), [assets, filter]);
  const captures = visible.filter((asset) => !asset.isPremium);
  const extras = visible.filter((asset) => asset.isPremium);
  const displayOrder = [...captures, ...extras];
  // Section headings only when the VISIBLE set spans both groups — a filter that empties
  // one group must not leave its heading behind.
  const hasExtras = extras.length > 0 && captures.length > 0;
  const filters = [
    { id: "all", label: "All" },
    ...(canRecommend ? [{ id: "recommended", label: "Recommended" }] : []),
    { id: "rated", label: "Rated" },
    { id: "labeled", label: "Labeled" },
    ...(canSelect ? [{ id: "selected", label: "For editing" }] : []),
  ];

  function toggleMulti(asset: WorkspaceAsset, shifted: boolean) {
    const index = displayOrder.findIndex((item) => item.id === asset.id);
    setMulti((current) => {
      const next = new Set(current);
      if (shifted && lastSelected.current !== null) {
        const from = Math.min(lastSelected.current, index);
        const to = Math.max(lastSelected.current, index);
        for (let i = from; i <= to; i += 1) next.add(displayOrder[i]!.id);
      } else if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id);
      return next;
    });
    lastSelected.current = index;
  }
  async function bulk(action: "approve" | "flag" | "recommend" | "select" | "rate" | "label") {
    const ids = [...multi];
    const patch = action === "approve" ? { decision: "approved" as const } : action === "flag" ? { decision: "flagged" as const } : action === "recommend" ? { recommended: true } : action === "rate" ? { stars: 5 } : { colorLabel: "select" as const };
    await Promise.all(ids.map((id) => action === "select" ? onSelection(id, true) : onReview(id, patch)));
    setMulti(new Set());
  }
  function renderGrid(gridAssets: WorkspaceAsset[]) {
    return <div className="grid" style={{ "--cols": 4 } as CSSProperties}>{gridAssets.map((asset) => {
      const review = asset.review;
      const marked = multi.has(asset.id);
      const state = review?.decision;
      return <div className={`tile ${marked ? "is-selected" : ""} ${state ? `st-${state}` : ""} ${rating(asset) ? "has-rating" : ""} ${asset.selected ? "has-state" : ""}`} key={asset.id} role="button" tabIndex={0} onClick={() => onOpen(asset, displayOrder)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(asset, displayOrder); }}>
        <img loading="lazy" src={`/media/asset/${encodeURIComponent(asset.id)}/thumb`} alt={asset.originalFilename} /><div className="tile__scrim" />
        <button className="selbox" type="button" aria-label={`Select ${asset.originalFilename}`} onClick={(event) => { event.stopPropagation(); toggleMulti(asset, event.shiftKey); }}>✓</button>
        <span className="tile__num">{asset.originalFilename}</span>
        {review?.colorLabel && <span style={{ position: "absolute", top: 13, left: 42, zIndex: 4 }}><LabelDot color={LABELS.find((item) => item.value === review.colorLabel)?.color ?? "#fff"} name={labelName(review.colorLabel)} /></span>}
        <div className="tile__tools">
          {canReview && <><button className="icbtn icbtn--ondark" type="button" title="Approve" onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { decision: state === "approved" ? null : "approved" }); }}>✓</button><button className="icbtn icbtn--ondark" type="button" title="Flag" onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { decision: state === "flagged" ? null : "flagged" }); }}>⚑</button></>}
          {canRecommend && <button className="icbtn icbtn--ondark" type="button" title="Recommend" onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { recommended: !review?.recommended }); }}>★</button>}
          {canSelect && <button className="icbtn icbtn--ondark" type="button" title="Select for editing" onClick={(event) => { event.stopPropagation(); void onSelection(asset.id, !asset.selected); }}>↗</button>}
          {canSetCover && <button className="icbtn icbtn--ondark" type="button" title={storedCoverAssetId === asset.id ? "Remove as cover (use first RAW frame)" : "Use as project cover"} onClick={(event) => { event.stopPropagation(); void onSetCover(storedCoverAssetId === asset.id ? null : asset.id); }}>◈</button>}
        </div>
        <div className="statetags">
          {asset.selected && <span className="statetag st-editing">For editing</span>}
          {coverAssetId === asset.id && <span className="statetag">Cover</span>}
          {review?.recommended && !asset.selected && <span className="statetag">Recommended</span>}
          {state && <span className={`statetag st-${state}`}>{state === "approved" ? "Approved" : "Flagged"}</span>}
        </div>
        <Stars value={rating(asset)} />
      </div>;
    })}</div>;
  }

  return <>
    <div className="worktools"><div className="filter-chips">{filters.map((item) => <button type="button" className={`chip ${filter === item.id ? "is-active" : ""}`} key={item.id} onClick={() => setFilter(item.id)}>{item.label}<span className="cnt">{item.id === "all" ? assets.length : assets.filter((asset) => item.id === "recommended" ? asset.review?.recommended : item.id === "rated" ? rating(asset) > 0 : item.id === "labeled" ? Boolean(asset.review?.colorLabel) : asset.selected).length}</span></button>)}</div><div className="grow" /><span className="prog">{assets.length} frames</span></div>
    <div className="workgrid">
      {visible.length === 0 ? <div className="empty"><span className="serif">No frames in this view.</span>Choose another filter or upload the capture set.</div> : hasExtras ? <><div className="ey" style={{ margin: "4px 0 10px" }}>Captures</div>{captures.length > 0 && renderGrid(captures)}<div className="ey" style={{ margin: "22px 0 10px" }}>Extras</div>{extras.length > 0 && renderGrid(extras)}</> : renderGrid(visible)}
    </div>
    {multi.size > 0 && <div className="actionbar"><span className="n">{multi.size}</span><span className="lbl">selected</span><span className="vline" />{canReview && <><button className="barbtn" type="button" onClick={() => void bulk("rate")}>Rate 5</button><button className="barbtn" type="button" onClick={() => void bulk("label")}>Label</button><button className="barbtn barbtn--solid" type="button" onClick={() => void bulk("approve")}>Approve</button><button className="barbtn" type="button" onClick={() => void bulk("flag")}>Flag</button></>}{canRecommend && <button className="barbtn barbtn--solid" type="button" onClick={() => void bulk("recommend")}>Recommend</button>}{canSelect && <button className="barbtn" type="button" onClick={() => void bulk("select")}>Select for editing</button>}<button className="barbtn" type="button" onClick={() => setMulti(new Set())}>Clear</button></div>}
  </>;
}
