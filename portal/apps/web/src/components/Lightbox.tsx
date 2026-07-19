import { useEffect, useMemo, useState } from "react";
import type { ReviewPatch, WorkspaceAsset } from "./PhotoGrid";

const labels = [
  { value: "hero", name: "Hero", color: "#9a6a1f" }, { value: "select", name: "Select", color: "#3f5b3a" }, { value: "maybe", name: "Maybe", color: "#2f3b4d" }, { value: "cut", name: "Cut", color: "#7a2420" },
] as const;

interface LightboxProps {
  assets: WorkspaceAsset[];
  initialAssetId: string;
  canReview: boolean;
  canRecommend: boolean;
  onClose: () => void;
  onReview: (assetId: string, patch: ReviewPatch) => Promise<void>;
}

export function Lightbox({ assets, initialAssetId, canReview, canRecommend, onClose, onReview }: LightboxProps) {
  const [index, setIndex] = useState(() => Math.max(0, assets.findIndex((asset) => asset.id === initialAssetId)));
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const [isPickingComparison, setIsPickingComparison] = useState(false);
  const asset = assets[index]!;
  const compareAsset = useMemo(() => assets.find((item) => item.id === comparisonId) ?? null, [assets, comparisonId]);
  const stars = asset.review?.stars ?? asset.ratingFromMetadata ?? 0;
  const move = (change: number) => setIndex((current) => (current + change + assets.length) % assets.length);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { onClose(); return; }
      if (event.key === "ArrowLeft") { move(-1); return; }
      if (event.key === "ArrowRight") { move(1); return; }
      if (!canReview) return;
      if (event.key.toLowerCase() === "a") void onReview(asset.id, { decision: asset.review?.decision === "approved" ? null : "approved" });
      if (event.key.toLowerCase() === "x") void onReview(asset.id, { decision: asset.review?.decision === "flagged" ? null : "flagged" });
      if (/^[1-5]$/.test(event.key)) void onReview(asset.id, { stars: Number(event.key) });
      if (event.key === "0") void onReview(asset.id, { stars: null });
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [asset, canReview, onClose, onReview]);

  return <div className={`viewer ${compareAsset ? "viewer--compare" : ""}`} role="dialog" aria-modal="true" aria-label="Photo viewer">
    <div className="viewer__stage"><button className="icbtn icbtn--ondark viewer__close" type="button" onClick={onClose} aria-label="Close">×</button><div className="viewer__meta"><div className="a">{asset.originalFilename}</div><div className="b">Frame {index + 1} of {assets.length}</div></div><button className="icbtn icbtn--ondark viewer__nav prev" type="button" onClick={() => move(-1)} aria-label="Previous frame">←</button><div className="viewer__imgwrap"><img className="viewer__img" src={`/media/asset/${encodeURIComponent(asset.id)}/web`} alt={asset.originalFilename} /></div><button className="icbtn icbtn--ondark viewer__nav next" type="button" onClick={() => move(1)} aria-label="Next frame">→</button></div>
    {compareAsset && <div className="viewer__stage viewer__compare-stage"><div className="viewer__meta"><div className="a">Comparison</div><div className="b">{compareAsset.originalFilename}</div></div><div className="viewer__imgwrap"><img className="viewer__img" src={`/media/asset/${encodeURIComponent(compareAsset.id)}/web`} alt={compareAsset.originalFilename} /></div><button className="icbtn icbtn--ondark viewer__compare-close" type="button" onClick={() => setComparisonId(null)} aria-label="Exit comparison">×</button></div>}
    <aside className="vpanel open"><div className="vpanel__head"><div className="ey" style={{ marginBottom: 8 }}>RAW capture · {asset.width ?? "—"} × {asset.height ?? "—"}</div><div className="vpanel__addr serif">{asset.originalFilename}</div></div><div className="vpanel__scroll">
      {canReview && <section className="vpanel__sec"><div className="eylab">Decision</div><div className="decide"><button className={`dbtn on-approve ${asset.review?.decision === "approved" ? "is-on" : ""}`} type="button" onClick={() => void onReview(asset.id, { decision: asset.review?.decision === "approved" ? null : "approved" })}>✓ Approve</button><button className={`dbtn on-flag ${asset.review?.decision === "flagged" ? "is-on" : ""}`} type="button" onClick={() => void onReview(asset.id, { decision: asset.review?.decision === "flagged" ? null : "flagged" })}>⚑ Flag</button></div></section>}
      {canRecommend && <section className="vpanel__sec"><div className="eylab">Recommendation</div><button className={`dbtn ${asset.review?.recommended ? "is-on" : ""}`} style={{ width: "100%" }} type="button" onClick={() => void onReview(asset.id, { recommended: !asset.review?.recommended })}>{asset.review?.recommended ? "Recommended to QA" : "Recommend to QA"}</button></section>}
      {canReview && <section className="vpanel__sec"><div className="eylab">Rating</div><div className="starpick">{[1, 2, 3, 4, 5].map((number) => <button key={number} type="button" className={number <= stars ? "on" : ""} onClick={() => void onReview(asset.id, { stars: number === stars ? null : number })}>★</button>)}</div></section>}
      {canReview && <section className="vpanel__sec"><div className="eylab">Label</div><div className="labels">{labels.map((label) => <button className={`labelpick ${asset.review?.colorLabel === label.value ? "is-on" : ""}`} type="button" key={label.value} style={{ background: label.color }} title={label.name} onClick={() => void onReview(asset.id, { colorLabel: asset.review?.colorLabel === label.value ? null : label.value })} />)}</div></section>}
      <section className="vpanel__sec"><div className="eylab">Compare frames</div><p className="muted" style={{ fontSize: 13.5, lineHeight: 1.5 }}>Choose another frame from the filmstrip to inspect both images side by side.</p></section>
    </div></aside>
    <div className="strip">{assets.map((item, itemIndex) => <button className={`strip__button ${itemIndex === index ? "is-active" : ""} ${comparisonId === item.id ? "is-compare" : ""}`} type="button" key={item.id} onClick={() => { if (isPickingComparison && item.id !== asset.id) { setComparisonId(item.id); setIsPickingComparison(false); } else setIndex(itemIndex); }} title={isPickingComparison ? "Choose this frame for comparison" : item.originalFilename}><img className="strip__t" src={`/media/asset/${encodeURIComponent(item.id)}/thumb`} alt={item.originalFilename} /></button>)}</div>
    {!comparisonId && <button className="compare-trigger" type="button" onClick={() => setIsPickingComparison(true)}>{isPickingComparison ? "Choose a second frame below" : "Compare this frame"}</button>}
  </div>;
}
