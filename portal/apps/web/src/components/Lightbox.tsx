import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { useSession } from "../lib/auth";
import type { ReviewPatch, WorkspaceAsset } from "./PhotoGrid";

const labels = [
  { value: "hero", name: "Hero", color: "#9a6a1f" }, { value: "select", name: "Select", color: "#3f5b3a" }, { value: "maybe", name: "Maybe", color: "#2f3b4d" }, { value: "cut", name: "Cut", color: "#7a2420" },
] as const;
type Point = { x: number; y: number };
type Stroke = { points: Point[]; color: string; width: number };
type Annotation = { id: string; authorId: string; author: { id: string; name: string; role: string }; scope: "raw" | "edited"; strokeR2Key: string | null; noteText: string | null; createdAt: string; editedAt: string | null };
type ThreadComment = { id: string; parentId: string | null; authorId: string; body: string; author: { id: string; name: string; role: string }; createdAt: string; editedAt: string | null; replies: ThreadComment[] };
type AnnotationResponse = { annotations: Annotation[]; comments: ThreadComment[] };

interface LightboxProps {
  assets: WorkspaceAsset[];
  rawAssets: WorkspaceAsset[];
  initialAssetId: string;
  collectionKind: "raw" | "edited";
  canReview: boolean;
  canRecommend: boolean;
  canAnnotate: boolean;
  onClose: () => void;
  onReview: (assetId: string, patch: ReviewPatch) => Promise<void>;
  onToast: (message: string, tone?: "success" | "error") => void;
}

function pointsString(points: Point[]) { return points.map((point) => `${point.x},${point.y}`).join(" "); }
function time(value: string) { return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function replaceComment(comments: ThreadComment[], id: string, patch: Partial<ThreadComment>): ThreadComment[] {
  return comments.map((comment) => ({ ...comment, ...(comment.id === id ? patch : {}), replies: replaceComment(comment.replies, id, patch) }));
}

export function Lightbox({ assets, rawAssets, initialAssetId, collectionKind, canReview, canRecommend, canAnnotate, onClose, onReview, onToast }: LightboxProps) {
  const session = useSession();
  const currentUserId = (session.data?.user as { id?: string | null } | undefined)?.id ?? null;
  const [index, setIndex] = useState(() => Math.max(0, assets.findIndex((asset) => asset.id === initialAssetId)));
  const [showRawCompare, setShowRawCompare] = useState(false);
  const [markup, setMarkup] = useState(false);
  const [tool, setTool] = useState({ color: "#e64b3c", width: 4 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [shownStrokes, setShownStrokes] = useState<Stroke[]>([]);
  const [annotationNote, setAnnotationNote] = useState("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [comments, setComments] = useState<ThreadComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationNote, setEditingAnnotationNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(false);
  const asset = assets[index]!;
  const rawCompareAsset = useMemo(() => asset.sourceRawAssetId ? rawAssets.find((item) => item.id === asset.sourceRawAssetId) ?? null : null, [asset.sourceRawAssetId, rawAssets]);
  const stars = asset.review?.stars ?? asset.ratingFromMetadata ?? 0;
  const move = (change: number) => setIndex((current) => (current + change + assets.length) % assets.length);

  const refreshDiscussion = async () => {
    const response = await apiGet<AnnotationResponse>(`/api/assets/${asset.id}/annotations`);
    setAnnotations(response.annotations); setComments(response.comments);
  };
  useEffect(() => {
    setMarkup(false); setStrokes([]); setShownStrokes([]); setAnnotationNote(""); setCommentBody(""); setReplyTo(null); setEditingCommentId(null); setEditingAnnotationId(null);
    void refreshDiscussion().catch(() => { setAnnotations([]); setComments([]); });
  // Asset identity is the intentional refresh boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
        if (event.key === "Escape") { event.preventDefault(); cancelInlineEdit(); }
        return;
      }
      if (event.key === "Escape") { if (markup) { setMarkup(false); setStrokes([]); return; } onClose(); return; }
      if (event.key === "ArrowLeft") { move(-1); return; }
      if (event.key === "ArrowRight") { move(1); return; }
      if (markup && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); setStrokes((current) => current.slice(0, -1)); return; }
      if (!canReview) return;
      if (event.key.toLowerCase() === "a") void onReview(asset.id, { decision: asset.review?.decision === "approved" ? null : "approved" });
      if (event.key.toLowerCase() === "x") void onReview(asset.id, { decision: asset.review?.decision === "flagged" ? null : "flagged" });
      if (/^[1-5]$/.test(event.key)) void onReview(asset.id, { stars: Number(event.key) });
      if (event.key === "0") void onReview(asset.id, { stars: null });
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [asset, canReview, markup, onClose, onReview]);

  function pointerPoint(event: React.PointerEvent<SVGSVGElement>): Point {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(1, Number(((event.clientX - rect.left) / rect.width).toFixed(4)))), y: Math.max(0, Math.min(1, Number(((event.clientY - rect.top) / rect.height).toFixed(4)))) };
  }
  function drawDown(event: React.PointerEvent<SVGSVGElement>) { if (!markup) return; event.preventDefault(); drawingRef.current = true; setStrokes((current) => [...current, { color: tool.color, width: tool.width, points: [pointerPoint(event)] }]); event.currentTarget.setPointerCapture(event.pointerId); }
  function drawMove(event: React.PointerEvent<SVGSVGElement>) { if (!markup || !drawingRef.current) return; const point = pointerPoint(event); setStrokes((current) => { if (!current.length) return current; const next = current.slice(); const last = next[next.length - 1]!; next[next.length - 1] = { ...last, points: [...last.points, point] }; return next; }); }
  function drawUp() { drawingRef.current = false; }
  async function saveAnnotation() {
    if (!canAnnotate || (!strokes.length && !annotationNote.trim())) return;
    setIsSaving(true);
    try { await apiPost(`/api/assets/${asset.id}/annotations`, { strokes: strokes.length ? strokes : undefined, noteText: annotationNote.trim() || undefined }); setStrokes([]); setAnnotationNote(""); setMarkup(false); await refreshDiscussion(); }
    finally { setIsSaving(false); }
  }
  async function showAnnotation(annotation: Annotation) {
    if (!annotation.strokeR2Key) return;
    const result = await apiGet<unknown>(`/media/annotation/${annotation.id}`);
    if (Array.isArray(result)) setShownStrokes(result as Stroke[]);
  }
  async function postComment() {
    if (!canAnnotate || !commentBody.trim()) return;
    setIsSaving(true);
    try { await apiPost(`/api/assets/${asset.id}/comments`, { body: commentBody.trim(), parentId: replyTo ?? undefined }); setCommentBody(""); setReplyTo(null); await refreshDiscussion(); }
    finally { setIsSaving(false); }
  }
  function cancelInlineEdit() {
    setEditingCommentId(null); setEditingCommentBody(""); setEditingAnnotationId(null); setEditingAnnotationNote("");
  }
  async function saveCommentEdit() {
    if (!editingCommentId || !editingCommentBody.trim()) return;
    const commentId = editingCommentId;
    const body = editingCommentBody.trim();
    const before = comments;
    const optimisticEditedAt = new Date().toISOString();
    setComments((current) => replaceComment(current, commentId, { body, editedAt: optimisticEditedAt }));
    cancelInlineEdit(); setIsSaving(true);
    try {
      const updated = await apiPatch<{ body: string; editedAt: string | null }, { body: string }>(`/api/comments/${commentId}`, { body });
      setComments((current) => replaceComment(current, commentId, { body: updated.body, editedAt: updated.editedAt }));
    } catch (reason) {
      setComments(before); setEditingCommentId(commentId); setEditingCommentBody(body);
      onToast(reason instanceof Error ? reason.message : "The comment could not be updated.", "error");
    } finally { setIsSaving(false); }
  }
  async function saveAnnotationEdit() {
    if (!editingAnnotationId) return;
    const annotationId = editingAnnotationId;
    const noteText = editingAnnotationNote.trim() || null;
    const before = annotations;
    const optimisticEditedAt = new Date().toISOString();
    setAnnotations((current) => current.map((annotation) => annotation.id === annotationId ? { ...annotation, noteText, editedAt: optimisticEditedAt } : annotation));
    cancelInlineEdit(); setIsSaving(true);
    try {
      const updated = await apiPatch<{ noteText: string | null; editedAt: string | null }, { noteText: string | null }>(`/api/annotations/${annotationId}`, { noteText });
      setAnnotations((current) => current.map((annotation) => annotation.id === annotationId ? { ...annotation, noteText: updated.noteText, editedAt: updated.editedAt } : annotation));
    } catch (reason) {
      setAnnotations(before); setEditingAnnotationId(annotationId); setEditingAnnotationNote(noteText ?? "");
      onToast(reason instanceof Error ? reason.message : "The annotation note could not be updated.", "error");
    } finally { setIsSaving(false); }
  }

  const drawLayer = <svg className="markup-svg" viewBox="0 0 1 1" preserveAspectRatio="none" style={{ pointerEvents: markup ? "auto" : "none", cursor: markup ? "crosshair" : "default", touchAction: "none" }} onPointerDown={drawDown} onPointerMove={drawMove} onPointerUp={drawUp} onPointerLeave={drawUp}>
    {[...shownStrokes, ...strokes].map((stroke, index) => stroke.points.length < 2 ? <circle key={`${index}-${stroke.points[0]?.x ?? 0}`} cx={stroke.points[0]?.x} cy={stroke.points[0]?.y} r={stroke.width / 600} fill={stroke.color} /> : <polyline key={index} points={pointsString(stroke.points)} fill="none" stroke={stroke.color} strokeWidth={stroke.width} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity={index < shownStrokes.length ? 0.82 : 1} />)}
  </svg>;
  const editedStage = <div className="viewer__stage"><button className="icbtn icbtn--ondark viewer__close" type="button" onClick={onClose} aria-label="Close">×</button><div className="viewer__meta"><div className="a">{asset.originalFilename}</div><div className="b">{collectionKind === "edited" ? "Edited" : "RAW"} · Frame {index + 1} of {assets.length}</div></div><button className="icbtn icbtn--ondark viewer__nav prev" type="button" onClick={() => move(-1)} aria-label="Previous frame">←</button><div className="viewer__imgwrap"><div className="canvasframe" ref={frameRef}><img className="viewer__img" src={`/media/asset/${encodeURIComponent(asset.id)}/web`} alt={asset.originalFilename} />{drawLayer}</div></div><button className="icbtn icbtn--ondark viewer__nav next" type="button" onClick={() => move(1)} aria-label="Next frame">→</button>
    {markup && <div className="drawbar"><span className="drawbar__lbl">Markup</span><span className="drawbar__grp">{["#e64b3c", "#f0a020", "#3f8f5a", "#2f6df0", "#ffffff", "#0a0a0a"].map((color) => <button key={color} className={`swatch ${tool.color === color ? "on" : ""}`} type="button" style={{ background: color }} onClick={() => setTool((current) => ({ ...current, color }))} />)}</span><span className="drawbar__grp">{[2, 4, 7].map((width) => <button key={width} className={`wbtn ${tool.width === width ? "on" : ""}`} type="button" onClick={() => setTool((current) => ({ ...current, width }))}><span style={{ width: width + 3, height: width + 3 }} /></button>)}</span><button className="barbtn" type="button" onClick={() => setStrokes((current) => current.slice(0, -1))}>Undo</button><button className="barbtn" type="button" onClick={() => setStrokes([])}>Clear</button></div>}
  </div>;

  return <div className={`viewer ${showRawCompare ? "viewer--compare" : ""}`} role="dialog" aria-modal="true" aria-label="Photo viewer">
    {showRawCompare && rawCompareAsset ? <div className="viewer__stage"><div className="viewer__meta"><div className="a">RAW comparison</div><div className="b">{rawCompareAsset.originalFilename}</div></div><div className="viewer__imgwrap"><div className="canvasframe"><img className="viewer__img" src={`/media/asset/${encodeURIComponent(rawCompareAsset.id)}/web`} alt={`RAW ${rawCompareAsset.originalFilename}`} /></div></div></div> : null}
    {editedStage}
    <aside className="vpanel open"><div className="vpanel__head"><div className="ey" style={{ marginBottom: 8 }}>{collectionKind === "edited" ? "Edited QA" : "RAW capture"} · {asset.width ?? "—"} × {asset.height ?? "—"}</div><div className="vpanel__addr serif">{asset.originalFilename}</div></div><div className="vpanel__scroll">
      {collectionKind === "edited" && rawCompareAsset && <section className="vpanel__sec"><div className="eylab">RAW ↔ Edited</div><button className={`dbtn ${showRawCompare ? "is-on" : ""}`} style={{ width: "100%" }} type="button" onClick={() => setShowRawCompare((current) => !current)}>{showRawCompare ? "Hide RAW comparison" : "Compare with RAW"}</button></section>}
      {canReview && <section className="vpanel__sec"><div className="eylab">Decision</div><div className="decide"><button className={`dbtn on-approve ${asset.review?.decision === "approved" ? "is-on" : ""}`} type="button" onClick={() => void onReview(asset.id, { decision: asset.review?.decision === "approved" ? null : "approved" })}>✓ Approve</button><button className={`dbtn on-flag ${asset.review?.decision === "flagged" ? "is-on" : ""}`} type="button" onClick={() => void onReview(asset.id, { decision: asset.review?.decision === "flagged" ? null : "flagged" })}>⚑ Flag</button></div></section>}
      {canRecommend && <section className="vpanel__sec"><div className="eylab">Recommendation</div><button className={`dbtn ${asset.review?.recommended ? "is-on" : ""}`} style={{ width: "100%" }} type="button" onClick={() => void onReview(asset.id, { recommended: !asset.review?.recommended })}>{asset.review?.recommended ? "Recommended to QA" : "Recommend to QA"}</button></section>}
      {canReview && <section className="vpanel__sec"><div className="eylab">Rating</div><div className="starpick">{[1, 2, 3, 4, 5].map((number) => <button key={number} type="button" className={number <= stars ? "on" : ""} onClick={() => void onReview(asset.id, { stars: number === stars ? null : number })}>★</button>)}</div></section>}
      {canReview && <section className="vpanel__sec"><div className="eylab">Label</div><div className="labels">{labels.map((label) => <button className={`labelpick ${asset.review?.colorLabel === label.value ? "is-on" : ""}`} type="button" key={label.value} style={{ background: label.color }} title={label.name} onClick={() => void onReview(asset.id, { colorLabel: asset.review?.colorLabel === label.value ? null : label.value })} />)}</div></section>}
      <section className="vpanel__sec"><div className="eylab" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span>Markup & annotations</span>{canAnnotate && <button className={`chip ${markup ? "is-active" : ""}`} type="button" onClick={() => setMarkup((current) => !current)}>{markup ? "Drawing…" : "Draw"}</button>}</div>{canAnnotate && <><textarea className="annotation-note" placeholder="Optional note for this markup…" value={annotationNote} onChange={(event) => setAnnotationNote(event.target.value)} /><button className="dbtn" style={{ width: "100%", marginTop: 8 }} type="button" disabled={isSaving || (!strokes.length && !annotationNote.trim())} onClick={() => void saveAnnotation()}>Save annotation</button></>}<div className="thread" style={{ marginTop: 14 }}>{annotations.length === 0 ? <div className="muted" style={{ fontSize: 14 }}>No annotations yet.</div> : annotations.map((annotation) => <div className="cmt" key={annotation.id}><div className="cmt__pin">✎</div><div className="cmt__b"><div className="cmt__who">{annotation.author.name}<span>{annotation.author.role}</span></div>{editingAnnotationId === annotation.id ? <><textarea className="annotation-note" aria-label="Edit annotation note" value={editingAnnotationNote} onChange={(event) => setEditingAnnotationNote(event.target.value)} /><div className="spread" style={{ marginTop: 6 }}><button className="comment-reply" type="button" onClick={cancelInlineEdit}>Cancel</button><button className="comment-reply" type="button" disabled={isSaving} onClick={() => void saveAnnotationEdit()}>Save</button></div></> : <>{annotation.noteText && <div className="cmt__txt">{annotation.noteText}</div>}{annotation.strokeR2Key && <button className="chip" style={{ marginTop: 6 }} type="button" onClick={() => void showAnnotation(annotation)}>Show markup</button>}<div className="ey muted" style={{ marginTop: 6 }}>{time(annotation.createdAt)}{annotation.editedAt && " · (edited)"}{annotation.authorId === currentUserId && <> · <button className="comment-reply" type="button" onClick={() => { setEditingCommentId(null); setEditingAnnotationId(annotation.id); setEditingAnnotationNote(annotation.noteText ?? ""); }}>Edit note</button></>}</div></>}</div></div>)}</div></section>
      <section className="vpanel__sec"><div className="eylab">Comments</div><CommentThread comments={comments} currentUserId={currentUserId} editingCommentId={editingCommentId} editingCommentBody={editingCommentBody} isSaving={isSaving} onReply={setReplyTo} onEdit={(comment) => { setEditingAnnotationId(null); setEditingCommentId(comment.id); setEditingCommentBody(comment.body); }} onEditBodyChange={setEditingCommentBody} onCancelEdit={cancelInlineEdit} onSaveEdit={() => void saveCommentEdit()} /></section>
    </div><div className="composer">{replyTo && <div className="hint">Replying to a comment · <button className="chip" type="button" onClick={() => setReplyTo(null)}>cancel</button></div>}<textarea placeholder={canAnnotate ? "Add a comment…" : "You do not have permission to comment."} disabled={!canAnnotate} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void postComment(); }} /><div className="spread"><span className="ey muted">⌘↵ to send</span><button className="barbtn barbtn--solid" type="button" disabled={!canAnnotate || isSaving || !commentBody.trim()} onClick={() => void postComment()}>Send comment</button></div></div></aside>
    <div className="strip">{assets.map((item, itemIndex) => <button className={`strip__button ${itemIndex === index ? "is-active" : ""}`} type="button" key={item.id} onClick={() => setIndex(itemIndex)} title={item.originalFilename}><img className="strip__t" src={`/media/asset/${encodeURIComponent(item.id)}/thumb`} alt={item.originalFilename} /></button>)}</div>
  </div>;
}

function CommentThread({ comments, currentUserId, editingCommentId, editingCommentBody, isSaving, onReply, onEdit, onEditBodyChange, onCancelEdit, onSaveEdit, depth = 0 }: { comments: ThreadComment[]; currentUserId: string | null; editingCommentId: string | null; editingCommentBody: string; isSaving: boolean; onReply: (id: string) => void; onEdit: (comment: ThreadComment) => void; onEditBodyChange: (body: string) => void; onCancelEdit: () => void; onSaveEdit: () => void; depth?: number }) {
  return <div className="thread">{comments.length === 0 ? <div className="muted" style={{ fontSize: 14 }}>No comments yet.</div> : comments.map((comment) => <div className="cmt" style={{ marginLeft: depth ? 16 : 0 }} key={comment.id}><div className="cmt__pin unpinned">●</div><div className="cmt__b"><div className="cmt__who">{comment.author.name}<span>{comment.author.role}</span></div>{editingCommentId === comment.id ? <><textarea className="annotation-note" aria-label="Edit comment" value={editingCommentBody} onChange={(event) => onEditBodyChange(event.target.value)} /><div className="spread" style={{ marginTop: 6 }}><button className="comment-reply" type="button" onClick={onCancelEdit}>Cancel</button><button className="comment-reply" type="button" disabled={isSaving || !editingCommentBody.trim()} onClick={onSaveEdit}>Save</button></div></> : <><div className="cmt__txt">{comment.body}</div><div className="ey muted" style={{ marginTop: 6 }}>{time(comment.createdAt)}{comment.editedAt && " · (edited)"} · <button className="comment-reply" type="button" onClick={() => onReply(comment.id)}>Reply</button>{comment.authorId === currentUserId && <> · <button className="comment-reply" type="button" onClick={() => onEdit(comment)}>Edit</button></>}</div></>}{comment.replies.length > 0 && <CommentThread comments={comment.replies} currentUserId={currentUserId} editingCommentId={editingCommentId} editingCommentBody={editingCommentBody} isSaving={isSaving} onReply={onReply} onEdit={onEdit} onEditBodyChange={onEditBodyChange} onCancelEdit={onCancelEdit} onSaveEdit={onSaveEdit} depth={depth + 1} />}</div></div>)}</div>;
}
