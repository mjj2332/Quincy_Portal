import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { useSession } from "../lib/auth";
import type { ReviewPatch, WorkspaceAsset } from "./PhotoGrid";
import { LazyImage } from "./LazyImage";
import { clampZoom, initialZoom, panBy, zoomBy, type ZoomBounds, type ZoomTransform } from "../lib/lightbox-zoom";
import { cycleLightboxIndex } from "../lib/lightbox-navigation";
import { useLightboxNeighborPreload } from "../lib/lightbox-neighbor-preload";

const labels = [
  { value: "hero", name: "Hero", color: "#9a6a1f" }, { value: "select", name: "Select", color: "#3f5b3a" }, { value: "maybe", name: "Maybe", color: "#2f3b4d" }, { value: "cut", name: "Cut", color: "#7a2420" },
] as const;
type Point = { x: number; y: number };
type Stroke = { points: Point[]; color: string; width: number };
type ViewerBand = "desktop" | "tablet" | "phone";
type Annotation = { id: string; authorId: string; author: { id: string; name: string; role: string }; scope: "raw" | "edited"; strokeR2Key: string | null; noteText: string | null; createdAt: string; editedAt: string | null };
type AnnotationResponse = { annotations: Annotation[] };

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
function strokeVisible(stroke: Stroke, key: string, opacity: number) { return stroke.points.length < 2 ? <circle key={key} cx={stroke.points[0]?.x} cy={stroke.points[0]?.y} r={stroke.width / 600} fill={stroke.color} opacity={opacity} className="stroke-vis" /> : <polyline key={key} points={pointsString(stroke.points)} fill="none" stroke={stroke.color} strokeWidth={stroke.width} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity={opacity} className="stroke-vis" />; }
function strokeHitTarget(stroke: Stroke, key: string) { return stroke.points.length < 2 ? <circle key={key} cx={stroke.points[0]?.x} cy={stroke.points[0]?.y} r={(stroke.width + 12) / 600} fill="transparent" style={{ pointerEvents: "fill" }} /> : <polyline key={key} points={pointsString(stroke.points)} fill="none" stroke="transparent" strokeWidth={stroke.width + 12} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "stroke" }} />; }
function viewerBand(): ViewerBand {
  if (typeof window === "undefined") return "desktop";
  if (window.innerWidth <= 720) return "phone";
  if (window.innerWidth <= 1080) return "tablet";
  return "desktop";
}

function FilmstripThumbnail({ asset, active, onSelect }: { asset: WorkspaceAsset; active: boolean; onSelect: () => void }) {
  const [failed, setFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  function activate() { if (failed) { setFailed(false); setRetryToken((current) => current + 1); } else onSelect(); }
  return <button className={`strip__button ${active ? "is-active" : ""}`} type="button" onClick={activate} title={failed ? `Retry ${asset.originalFilename}` : asset.originalFilename} aria-label={failed ? `Retry thumbnail for ${asset.originalFilename}` : asset.originalFilename}><LazyImage className="strip__t" preload="background" assetId={asset.id} alt={asset.originalFilename} retryToken={retryToken} onFailedChange={setFailed} /></button>;
}

export function Lightbox({ assets, rawAssets, initialAssetId, collectionKind, canReview, canRecommend, canAnnotate, onClose, onReview, onToast }: LightboxProps) {
  const session = useSession();
  const currentUserId = (session.data?.user as { id?: string | null } | undefined)?.id ?? null;
  const [index, setIndex] = useState(() => Math.max(0, assets.findIndex((asset) => asset.id === initialAssetId)));
  const activeAssetIdRef = useRef(initialAssetId);
  const idIndex = assets.findIndex((item) => item.id === activeAssetIdRef.current);
  const displayIndex = idIndex >= 0 ? idIndex : Math.min(Math.max(index, 0), Math.max(assets.length - 1, 0));
  useLightboxNeighborPreload(assets, displayIndex);
  const [showRawCompare, setShowRawCompare] = useState(false);
  const [markupVisible, setMarkupVisible] = useState(true);
  const [editingDrawingId, setEditingDrawingId] = useState<string | null>(null);
  const [strokeCache, setStrokeCache] = useState<Map<string, { key: string; strokes: Stroke[] }>>(new Map());
  const [highlightedAnnotationId, setHighlightedAnnotationId] = useState<string | null>(null);
  const [tool, setTool] = useState({ color: "#e64b3c", width: 4 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [annotationNote, setAnnotationNote] = useState("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingAnnotationNote, setEditingAnnotationNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [zoom, setZoom] = useState<ZoomTransform>(initialZoom);
  const [panelOpen, setPanelOpen] = useState(false);
  const [band, setBand] = useState<ViewerBand>(viewerBand);
  const frameRef = useRef<HTMLDivElement>(null);
  const rawFrameRef = useRef<HTMLDivElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const peekHandleRef = useRef<HTMLButtonElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const panelTriggerRef = useRef<HTMLElement | null>(null);
  const drawingRef = useRef(false);
  const annotationRefs = useRef(new Map<string, HTMLDivElement>());
  const highlightTimeoutRef = useRef<number | null>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number; width: number; height: number; bounds: ZoomBounds } | null>(null);
  const pinchRef = useRef<{ distance: number; scale: number; bounds: ZoomBounds } | null>(null);
  const swipeRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number; committed: boolean } | null>(null);
  const asset = assets[displayIndex]!;
  activeAssetIdRef.current = asset.id;
  useEffect(() => {
    const nextIndex = assets.findIndex((item) => item.id === activeAssetIdRef.current);
    if (nextIndex >= 0) setIndex(nextIndex);
    else if (!assets.length) onClose();
  }, [assets, onClose]);
  // Always the LATEST asset id, updated synchronously every render (unlike a value
  // captured in an effect/async closure) — the only reliable way to detect, from inside
  // a promise that resolves after the user has since navigated, that its response is stale.
  const currentAssetIdRef = useRef(asset.id);
  currentAssetIdRef.current = asset.id;
  const mutationGenerationRef = useRef(0);
  const mutationAssetRef = useRef(asset.id);
  const strokesRef = useRef(strokes);
  const annotationNoteRef = useRef(annotationNote);
  const editingDrawingIdRef = useRef(editingDrawingId);
  // Increment during render so an A→B→A navigation invalidates old A completions before
  // effects run; asset ID alone cannot distinguish that round trip.
  if (mutationAssetRef.current !== asset.id) { mutationAssetRef.current = asset.id; mutationGenerationRef.current += 1; }
  strokesRef.current = strokes;
  annotationNoteRef.current = annotationNote;
  editingDrawingIdRef.current = editingDrawingId;
  const hasDraftMarkup = strokes.length > 0 || editingDrawingId !== null || annotationNote.trim().length > 0 || editingAnnotationId !== null;
  const rawCompareAsset = useMemo(() => asset.sourceRawAssetId ? rawAssets.find((item) => item.id === asset.sourceRawAssetId) ?? null : null, [asset.sourceRawAssetId, rawAssets]);
  const compareActive = band !== "phone" && showRawCompare && Boolean(rawCompareAsset);
  const stars = asset.review?.stars ?? asset.ratingFromMetadata ?? 0;
  const move = (change: number) => {
    if (hasDraftMarkup && !window.confirm("Discard the current unsaved markup?")) return;
    setIndex((current) => { const next = cycleLightboxIndex(current, change, assets.length); activeAssetIdRef.current = assets[next]?.id ?? activeAssetIdRef.current; return next; });
  };

  useEffect(() => {
    function updateBand() { setBand(viewerBand()); }
    updateBand();
    window.addEventListener("resize", updateBand);
    return () => window.removeEventListener("resize", updateBand);
  }, []);

  useEffect(() => {
    if (band === "phone") setShowRawCompare(false);
  }, [band]);

  function focusPanelTrigger() {
    window.requestAnimationFrame(() => {
      const trigger = panelTriggerRef.current;
      if (trigger && document.contains(trigger) && trigger.tabIndex >= 0) {
        trigger.focus();
        return;
      }
      if (band === "phone") peekHandleRef.current?.focus();
      else reviewTriggerRef.current?.focus();
    });
  }
  function openPanel(trigger: HTMLElement) {
    panelTriggerRef.current = trigger;
    setPanelOpen(true);
  }
  function closePanel() {
    if (!panelOpen) return;
    setPanelOpen(false);
    focusPanelTrigger();
  }
  function collapsePhonePanelForMarkup() {
    if (band !== "phone") return;
    setPanelOpen(false);
    window.requestAnimationFrame(() => peekHandleRef.current?.focus());
  }
  useEffect(() => {
    if (!panelOpen || band === "desktop") return;
    const frame = window.requestAnimationFrame(() => collapseButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [band, panelOpen]);
  // An asset-id comparison alone cannot order two in-flight requests for the SAME asset
  // (a quick A→B→A hop, or two refreshes fired back-to-back on A) — whichever happens to
  // resolve last would win even if it was issued first. A monotonically increasing
  // generation fixes that: only the response from the most-recently-issued call is ever
  // applied, regardless of arrival order.
  // That generation only orders requests; it does not establish which asset a winning
  // response belongs to. Check the current asset too, so a slow mutation refresh from a
  // previously displayed asset cannot overwrite the discussion now on screen.
  const refreshGenRef = useRef(0);
  const refreshDiscussion = async () => {
    if (currentAssetIdRef.current !== asset.id) return; // a stale mutation refresh must never touch the shared generation
    const assetIdAtCall = asset.id;
    const gen = ++refreshGenRef.current;
    const response = await apiGet<AnnotationResponse>(`/api/assets/${assetIdAtCall}/annotations`);
    if (gen !== refreshGenRef.current) return; // a newer refresh call has since superseded this one — discard
    if (currentAssetIdRef.current !== assetIdAtCall) return; // the user has since navigated to a different asset — discard
    setAnnotations(response.annotations);
  };
  useEffect(() => {
    if (highlightTimeoutRef.current) window.clearTimeout(highlightTimeoutRef.current);
    setShowRawCompare(false); setStrokes([]); setEditingDrawingId(null); setStrokeCache(new Map()); setMarkupVisible(true); setHighlightedAnnotationId(null); setAnnotationNote(""); setEditingAnnotationId(null); setEditingAnnotationNote(""); setIsSaving(false); setZoom(initialZoom());
    const pending = refreshDiscussion();
    const gen = refreshGenRef.current; // refreshDiscussion's synchronous prefix has already run and assigned this
    void pending.catch(() => { if (refreshGenRef.current === gen) setAnnotations([]); });
  // Asset identity is the intentional refresh boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id]);
  useEffect(() => {
    // Always-visible markup (WP-M/A): fetch stroke JSON for every annotation with a
    // strokeR2Key, in parallel, cached by annotation id + strokeR2Key so an edited
    // drawing (new key) refetches. Stale entries whose annotation lost its key (Clear)
    // are pruned. Failed fetches are tolerated — never block the lightbox.
    const assetIdAtStart = asset.id;
    const withKeys = new Map(annotations.filter((annotation) => annotation.strokeR2Key).map((annotation) => [annotation.id, annotation.strokeR2Key as string]));
    setStrokeCache((current) => { const next = new Map([...current].filter(([id]) => withKeys.has(id))); return next.size === current.size ? current : next; });
    const missing = [...withKeys.entries()].filter(([id, key]) => strokeCache.get(id)?.key !== key);
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(missing.map(async ([id, key]) => {
      try {
        const result = await apiGet<unknown>(`/media/annotation/${id}`);
        // currentAssetIdRef (not a value captured in this closure) is what actually
        // detects "the user has since navigated to a different asset" — comparing two
        // variables from the same closure would always be equal and prove nothing.
        if (!cancelled && currentAssetIdRef.current === assetIdAtStart && Array.isArray(result)) setStrokeCache((current) => new Map(current).set(id, { key, strokes: result as Stroke[] }));
      } catch { console.warn(`Markup fetch failed for annotation ${id}`); }
    }));
    return () => { cancelled = true; };
  // strokeCache is read but intentionally excluded: including it would re-run this
  // effect on every fetch resolution, refetching in a loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, asset.id]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target instanceof Element ? event.target : null;
      // Only genuine text-entry elements suppress the drawing-mode shortcuts below — a focused
      // toolbar button (a swatch, Undo, Clear) must NOT suppress them, since Escape/undo should
      // still work when the user's focus happens to be on a button rather than the canvas.
      const inEditableField = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      // Exiting drawing mode takes priority over everything else on Escape, including
      // the textarea-focus cancel-inline-edit path below — you can be mid-stroke with
      // focus never having left the canvas, or (less commonly) with a stray textarea
      // still focused, and either way Escape must stop the drawing first — unless focus is in a
      // genuine text field (e.g. the comment box), where Escape/blur should behave natively
      // instead of yanking the user out of drawing mode mid-comment.
      if (event.key === "Escape" && hasDraftMarkup) { if (inEditableField) return; event.preventDefault(); exitDrawMode(); return; }
      // Markup owns the keyboard: never navigate or apply review shortcuts while a drawing
      // draft is active. Escape above and undo below are the only supported keys.
      if (hasDraftMarkup && !inEditableField && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); setStrokes((current) => current.slice(0, -1)); return; }
      if (hasDraftMarkup) return;
      // Sheet behavior is deliberately ahead of the legacy interactive-element branch:
      // the collapse button is itself a button, and the closed-state trigger must allow
      // the second Escape to close the lightbox rather than canceling an inline edit.
      if (event.key === "Escape" && band !== "desktop") {
        if (panelOpen) { event.preventDefault(); closePanel(); return; }
        if (target?.closest(".viewer__panel-trigger, .vpanel__peek")) { event.preventDefault(); onClose(); return; }
      }
      if (target?.closest("input, textarea, select, button, a, [contenteditable='true']")) {
        if (event.key === "Escape") { event.preventDefault(); cancelInlineEdit(); }
        return;
      }
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
  }, [asset, band, canReview, closePanel, hasDraftMarkup, onClose, onReview, panelOpen]);

  function pointerPoint(event: React.PointerEvent<SVGSVGElement>): Point {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(1, Number(((event.clientX - rect.left) / rect.width).toFixed(4)))), y: Math.max(0, Math.min(1, Number(((event.clientY - rect.top) / rect.height).toFixed(4)))) };
  }
  function drawDown(event: React.PointerEvent<SVGSVGElement>) { if (!canAnnotate) return; if (strokes.length === 0 && editingDrawingId === null && editingAnnotationId !== null) { if (!window.confirm("Discard the note edit in progress?")) return; cancelInlineEdit(); } event.preventDefault(); drawingRef.current = true; setStrokes((current) => [...current, { color: tool.color, width: tool.width, points: [pointerPoint(event)] }]); event.currentTarget.setPointerCapture(event.pointerId); }
  function drawMove(event: React.PointerEvent<SVGSVGElement>) { if (!canAnnotate || !drawingRef.current) return; const point = pointerPoint(event); setStrokes((current) => { if (!current.length) return current; const next = current.slice(); const last = next[next.length - 1]!; next[next.length - 1] = { ...last, points: [...last.points, point] }; return next; }); }
  function drawUp() { drawingRef.current = false; }
  async function saveAnnotation() {
    if (!canAnnotate || editingDrawingId || (!strokes.length && !annotationNote.trim())) return;
    const assetIdAtStart = asset.id;
    const mutation = ++mutationGenerationRef.current;
    const submittedStrokes = strokes;
    const submittedNote = annotationNote.trim();
    setIsSaving(true);
    try {
      const created = await apiPost<Annotation, { strokes?: Stroke[]; noteText?: string }>(`/api/assets/${assetIdAtStart}/annotations`, { strokes: submittedStrokes.length ? submittedStrokes : undefined, noteText: submittedNote || undefined });
      if (mutation !== mutationGenerationRef.current || currentAssetIdRef.current !== assetIdAtStart) return;
      setAnnotations((current) => current.some((item) => item.id === created.id) ? current : [...current, created]);
      // Clear only the submitted snapshot. The artist may have continued drawing/typing while
      // this POST ran, and that newer draft belongs to the next save.
      const strokesUnchanged = strokesRef.current === submittedStrokes;
      const noteUnchanged = annotationNoteRef.current.trim() === submittedNote;
      if (strokesUnchanged) setStrokes([]);
      if (noteUnchanged) setAnnotationNote("");
      void refreshDiscussion().catch(() => undefined);
    } catch (reason) {
      if (mutation === mutationGenerationRef.current && currentAssetIdRef.current === assetIdAtStart) onToast(reason instanceof Error ? reason.message : "The annotation could not be saved.", "error");
    }
    finally { if (mutation === mutationGenerationRef.current && currentAssetIdRef.current === assetIdAtStart) setIsSaving(false); }
  }
  function exitDrawMode() { setStrokes([]); setAnnotationNote(""); setEditingDrawingId(null); cancelInlineEdit(); }
  /** True once an annotation's CURRENT strokes are cached — gating drawing-edit on this prevents seeding the editor with [] and silently erasing the drawing on Save. */
  function strokesReady(annotation: Annotation) { return !annotation.strokeR2Key || strokeCache.get(annotation.id)?.key === annotation.strokeR2Key; }
  function startDrawingEdit(annotation: Annotation) {
    if (hasDraftMarkup || isSaving || !strokesReady(annotation)) return;
    cancelInlineEdit();
    const cached = strokeCache.get(annotation.id);
    const preload = cached && cached.key === annotation.strokeR2Key ? cached.strokes.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point })) })) : [];
    setStrokes(preload); setEditingDrawingId(annotation.id); setZoom(initialZoom()); collapsePhonePanelForMarkup();
  }
  async function saveDrawingEdit() {
    if (!editingDrawingId) return;
    const assetIdAtStart = asset.id;
    const annotationId = editingDrawingId;
    setIsSaving(true);
    try { await apiPatch<{ strokeR2Key: string | null; editedAt: string | null }, { strokes: Stroke[] }>(`/api/annotations/${annotationId}`, { strokes }); await refreshDiscussion(); exitDrawMode(); onToast("Drawing updated.", "success"); }
    catch (reason) { onToast(reason instanceof Error ? reason.message : "The drawing could not be updated.", "error"); }
    finally { if (currentAssetIdRef.current === assetIdAtStart) setIsSaving(false); }
  }
  function selectAnnotation(id: string) {
    if (canAnnotate) return;
    annotationRefs.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (highlightTimeoutRef.current) window.clearTimeout(highlightTimeoutRef.current);
    setHighlightedAnnotationId(id);
    highlightTimeoutRef.current = window.setTimeout(() => setHighlightedAnnotationId(null), 1600);
  }
  function cancelInlineEdit() {
    setEditingAnnotationId(null); setEditingAnnotationNote("");
  }
  async function deleteAnnotation(annotation: Annotation) {
    if (!window.confirm(annotation.strokeR2Key ? "Delete this annotation and its markup?" : "Delete this annotation?")) return;
    const assetIdAtDelete = asset.id;
    const before = annotations;
    const strokeCacheBefore = strokeCache;
    const editingAnnotationBefore = editingAnnotationId;
    const editingAnnotationNoteBefore = editingAnnotationNote;
    const editingDrawingBefore = editingDrawingId;
    const strokesBefore = strokes;
    if (editingDrawingId === annotation.id) exitDrawMode();
    setAnnotations((current) => current.filter((item) => item.id !== annotation.id));
    setStrokeCache((current) => { const next = new Map(current); next.delete(annotation.id); return next; });
    if (highlightedAnnotationId === annotation.id) setHighlightedAnnotationId(null);
    if (editingAnnotationId === annotation.id) { setEditingAnnotationId(null); setEditingAnnotationNote(""); }
    setIsSaving(true);
    try {
      const response = await fetch(`/api/annotations/${encodeURIComponent(annotation.id)}`, { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
      if (!response.ok) throw new Error(payload?.error ?? "The annotation could not be deleted.");
    } catch (reason) {
      if (currentAssetIdRef.current === assetIdAtDelete) {
        setAnnotations(before); setStrokeCache(strokeCacheBefore); setEditingAnnotationId(editingAnnotationBefore); setEditingAnnotationNote(editingAnnotationNoteBefore);
        if (editingDrawingBefore === annotation.id) { setEditingDrawingId(editingDrawingBefore); setStrokes(strokesBefore); }
        onToast(reason instanceof Error ? reason.message : "The annotation could not be deleted.", "error");
      }
      setIsSaving(false);
      return;
    }
    try {
      await refreshDiscussion();
      if (currentAssetIdRef.current === assetIdAtDelete) onToast("Annotation deleted.", "success");
    } catch {
      if (currentAssetIdRef.current === assetIdAtDelete) onToast("Annotation deleted; the list may be briefly out of date.", "success");
    } finally { setIsSaving(false); }
  }
  async function saveAnnotationEdit() {
    if (!editingAnnotationId) return;
    const assetIdAtStart = asset.id;
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
      if (currentAssetIdRef.current === assetIdAtStart) {
        setAnnotations(before);
        const anotherDraftStarted = strokesRef.current.length > 0 || editingDrawingIdRef.current !== null || annotationNoteRef.current.trim().length > 0;
        if (!anotherDraftStarted) { setEditingAnnotationId(annotationId); setEditingAnnotationNote(noteText ?? ""); }
        onToast(anotherDraftStarted
          ? "The annotation note could not be updated, and your edit could not be restored because new unsaved markup was started."
          : (reason instanceof Error ? reason.message : "The annotation note could not be updated."), "error");
      }
    } finally { setIsSaving(false); }
  }

  function resetZoom() { setZoom(initialZoom()); }
  function boundsFor(frame: HTMLDivElement): ZoomBounds {
    const viewport = frame.parentElement;
    return { viewportWidth: viewport?.clientWidth ?? frame.offsetWidth, viewportHeight: viewport?.clientHeight ?? frame.offsetHeight, imageWidth: frame.offsetWidth, imageHeight: frame.offsetHeight };
  }
  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (canAnnotate || zoom.scale <= 1) return;
    const rect = event.currentTarget.getBoundingClientRect();
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, bounds: boundsFor(event.currentTarget) };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function movePan(event: React.PointerEvent<HTMLDivElement>) {
    const active = panRef.current;
    if (!active || active.pointerId !== event.pointerId || canAnnotate) return;
    event.preventDefault();
    setZoom((current) => panBy(current, (event.clientX - active.x) / active.width, (event.clientY - active.y) / active.height, active.bounds));
    panRef.current = { ...active, x: event.clientX, y: event.clientY };
  }
  function endPan(event: React.PointerEvent<HTMLDivElement>) { if (panRef.current?.pointerId === event.pointerId) panRef.current = null; }
  function startSwipe(event: React.PointerEvent<HTMLDivElement>) {
    if (swipeRef.current) { swipeRef.current = null; return; }
    if (canAnnotate || zoom.scale !== 1 || event.pointerType !== "touch") return;
    swipeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, committed: false };
  }
  function moveSwipe(event: React.PointerEvent<HTMLDivElement>) {
    const active = swipeRef.current;
    if (!active || active.pointerId !== event.pointerId || canAnnotate || zoom.scale !== 1) return;
    swipeRef.current = { ...active, x: event.clientX, y: event.clientY };
  }
  function endSwipe(event: React.PointerEvent<HTMLDivElement>) {
    const active = swipeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    swipeRef.current = null;
    if (active.committed || canAnnotate || zoom.scale !== 1) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    const distance = 56;
    const verticalMargin = 12;
    if (Math.abs(dx) < distance || Math.abs(dx) <= Math.abs(dy) + verticalMargin) return;
    active.committed = true;
    move(dx < 0 ? 1 : -1);
  }
  function wheelZoom(event: React.WheelEvent<HTMLDivElement>) {
    if (canAnnotate) return;
    event.preventDefault();
    setZoom((current) => zoomBy(current, event.deltaY < 0 ? 0.2 : -0.2, boundsFor(event.currentTarget)));
  }
  function touchStartZoom(event: React.TouchEvent<HTMLDivElement>) {
    if (event.touches.length >= 2) swipeRef.current = null;
    if (canAnnotate || event.touches.length !== 2) return;
    const [first, second] = [event.touches[0]!, event.touches[1]!];
    pinchRef.current = { distance: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY), scale: zoom.scale, bounds: boundsFor(event.currentTarget) };
  }
  function touchMoveZoom(event: React.TouchEvent<HTMLDivElement>) {
    const pinch = pinchRef.current;
    if (canAnnotate || !pinch || event.touches.length !== 2) return;
    event.preventDefault(); const [first, second] = [event.touches[0]!, event.touches[1]!]; const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
    setZoom((current) => clampZoom({ ...current, scale: pinch.scale * (distance / pinch.distance) }, pinch.bounds));
  }
  function touchEndZoom() { pinchRef.current = null; }
  function zoomStyleFor(frame: React.RefObject<HTMLDivElement | null>) {
    const local = frame.current ? clampZoom(zoom, boundsFor(frame.current)) : zoom;
    return { transform: `translate(${local.panX * 100}%, ${local.panY * 100}%) scale(${local.scale})` };
  }

  const drawLayer = <svg className="markup-svg" viewBox="0 0 1 1" preserveAspectRatio="none" style={{ pointerEvents: canAnnotate ? "auto" : "none", cursor: canAnnotate ? "crosshair" : "default", touchAction: "none" }} onPointerDown={drawDown} onPointerMove={drawMove} onPointerUp={drawUp} onPointerLeave={drawUp}>
    {markupVisible && annotations.map((annotation) => {
      if (annotation.id === editingDrawingId || !annotation.strokeR2Key) return null;
      const cached = strokeCache.get(annotation.id);
      if (!cached || cached.key !== annotation.strokeR2Key) return null;
      const opacity = highlightedAnnotationId === annotation.id ? 1 : 0.82;
      return <g key={annotation.id} data-annotation-id={annotation.id} style={{ pointerEvents: canAnnotate ? "none" : "auto", cursor: "pointer", opacity: editingDrawingId ? 0.25 : 1 }} onClick={canAnnotate ? undefined : () => selectAnnotation(annotation.id)}>
        {cached.strokes.map((stroke, strokeIndex) => <g key={strokeIndex}>{strokeHitTarget(stroke, `hit-${strokeIndex}`)}{strokeVisible(stroke, `vis-${strokeIndex}`, opacity)}</g>)}
      </g>;
    })}
    {strokes.map((stroke, strokeIndex) => strokeVisible(stroke, `draft-${strokeIndex}`, 1))}
  </svg>;
  const editedStage = <div className="viewer__stage"><button className="icbtn icbtn--ondark viewer__close" type="button" onClick={() => { if (hasDraftMarkup && !window.confirm("Discard the current unsaved markup?")) return; onClose(); }} aria-label="Close">×</button><button ref={reviewTriggerRef} className="viewer__panel-trigger" type="button" onClick={(event) => openPanel(event.currentTarget)} aria-expanded={panelOpen} aria-controls="lightbox-review-panel">Review</button><div className="viewer__meta"><div className="a">{asset.originalFilename}</div><div className="b">{collectionKind === "edited" ? "Edited" : "RAW"} · Frame {displayIndex + 1} of {assets.length}</div></div><button className="icbtn icbtn--ondark viewer__nav prev" type="button" onClick={() => move(-1)} aria-label="Previous frame">←</button><div className="viewer__imgwrap"><div className={`canvasframe canvasframe--zoomable ${zoom.scale > 1 && !canAnnotate ? "is-zoomed" : ""}`} ref={frameRef} style={zoomStyleFor(frameRef)} onPointerDown={(event) => { startPan(event); startSwipe(event); }} onPointerMove={(event) => { movePan(event); moveSwipe(event); }} onPointerUp={(event) => { endSwipe(event); endPan(event); }} onPointerCancel={(event) => { swipeRef.current = null; endPan(event); }} onWheel={wheelZoom} onTouchStart={touchStartZoom} onTouchMove={touchMoveZoom} onTouchEnd={touchEndZoom}><img className="viewer__img" draggable={false} onDragStart={(event) => event.preventDefault()} src={`/media/asset/${encodeURIComponent(asset.id)}/web`} alt={asset.originalFilename} />{drawLayer}</div></div><button className="icbtn icbtn--ondark viewer__nav next" type="button" onClick={() => move(1)} aria-label="Next frame">→</button><div className={`viewer__shortcuts ${hasDraftMarkup ? "is-drawing" : ""}`} aria-hidden="true">{hasDraftMarkup ? <><span><kbd className="kbd">⌘Z</kbd> undo</span><i>·</i><span><kbd className="kbd">Esc</kbd> done</span></> : <><span><kbd className="kbd">←</kbd><kbd className="kbd">→</kbd> frames</span>{canReview && <><i>·</i><span><kbd className="kbd">A</kbd> approve</span><i>·</i><span><kbd className="kbd">X</kbd> flag</span><i>·</i><span><kbd className="kbd">1–5</kbd> rate</span><i>·</i><span><kbd className="kbd">0</kbd> clear</span></>}<i>·</i><span><kbd className="kbd">Esc</kbd> close</span></>}</div>
    {canAnnotate && <div className="drawbar"><span className="drawbar__lbl">{editingDrawingId ? "Editing drawing" : "Markup"}</span><span className="drawbar__grp">{["#e64b3c", "#f0a020", "#3f8f5a", "#2f6df0", "#ffffff", "#0a0a0a"].map((color) => <button key={color} className={`swatch ${tool.color === color ? "on" : ""}`} type="button" style={{ background: color }} onClick={() => setTool((current) => ({ ...current, color }))} />)}</span><span className="drawbar__grp">{[2, 4, 7].map((width) => <button key={width} className={`wbtn ${tool.width === width ? "on" : ""}`} type="button" onClick={() => setTool((current) => ({ ...current, width }))}><span style={{ width: width + 3, height: width + 3 }} /></button>)}</span><button className="barbtn" type="button" disabled={!strokes.length} onClick={() => setStrokes((current) => current.slice(0, -1))}>Undo</button><button className="barbtn" type="button" disabled={!strokes.length} onClick={() => setStrokes([])}>Clear</button>{editingDrawingId && <><button className="barbtn" type="button" onClick={exitDrawMode}>Cancel</button><button className="barbtn barbtn--solid" type="button" disabled={isSaving} onClick={() => void saveDrawingEdit()}>Save</button></>}</div>}
  </div>;

  return <div className={`viewer ${compareActive ? "viewer--compare" : ""}`} role="dialog" aria-modal="true" aria-label="Photo viewer">
    {compareActive && rawCompareAsset ? <div className="viewer__stage"><div className="viewer__meta"><div className="a">RAW comparison</div><div className="b">{rawCompareAsset.originalFilename}</div></div><div className="viewer__imgwrap"><div className={`canvasframe canvasframe--zoomable ${zoom.scale > 1 && !canAnnotate ? "is-zoomed" : ""}`} ref={rawFrameRef} style={zoomStyleFor(rawFrameRef)} onPointerDown={(event) => { startPan(event); startSwipe(event); }} onPointerMove={(event) => { movePan(event); moveSwipe(event); }} onPointerUp={(event) => { endSwipe(event); endPan(event); }} onPointerCancel={(event) => { swipeRef.current = null; endPan(event); }} onWheel={wheelZoom} onTouchStart={touchStartZoom} onTouchMove={touchMoveZoom} onTouchEnd={touchEndZoom}><img className="viewer__img" draggable={false} onDragStart={(event) => event.preventDefault()} src={`/media/asset/${encodeURIComponent(rawCompareAsset.id)}/web`} alt={`RAW ${rawCompareAsset.originalFilename}`} /></div></div></div> : null}
    {editedStage}
    {panelOpen && band !== "desktop" && <div className="viewer__panel-scrim" aria-hidden="true" onClick={closePanel} />}
    <aside id="lightbox-review-panel" className={`vpanel ${panelOpen ? "open" : ""}`}>
      {band === "phone" && !panelOpen ? <div className="vpanel__peek" onClick={(event) => openPanel(event.currentTarget)}>
        <div className="vpanel__peek-actions">
          {canReview && <><button className={`vpanel__peek-action on-approve ${asset.review?.decision === "approved" ? "is-on" : ""}`} type="button" aria-label="Approve" aria-pressed={asset.review?.decision === "approved"} onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { decision: asset.review?.decision === "approved" ? null : "approved" }); }}>✓</button><button className={`vpanel__peek-action on-flag ${asset.review?.decision === "flagged" ? "is-on" : ""}`} type="button" aria-label="Flag" aria-pressed={asset.review?.decision === "flagged"} onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { decision: asset.review?.decision === "flagged" ? null : "flagged" }); }}>⚑</button><button className="vpanel__peek-action vpanel__peek-rating" type="button" aria-label={stars ? `Rating ${stars} of 5. Change rating` : "Set rating"} onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { stars: stars >= 5 ? null : stars + 1 }); }}>★<span>{stars || "—"}</span></button></>}
        </div>
        <button ref={peekHandleRef} className="vpanel__peek-handle" type="button" onClick={(event) => { event.stopPropagation(); openPanel(event.currentTarget); }} aria-expanded={panelOpen} aria-controls="lightbox-review-panel"><span aria-hidden="true">⌃</span><span>Review</span></button>
      </div> : (panelOpen || band === "desktop") ? <>
        <div className="vpanel__head"><div className="ey" style={{ marginBottom: 8 }}>{collectionKind === "edited" ? "Edited QA" : "RAW capture"} · {asset.width ?? "—"} × {asset.height ?? "—"}</div><div className="vpanel__addr serif">{asset.originalFilename}</div>{band !== "desktop" && <button ref={collapseButtonRef} className="vpanel__collapse" type="button" onClick={closePanel} aria-label="Collapse review panel" aria-expanded={panelOpen} aria-controls="lightbox-review-panel">⌄</button>}</div><div className="vpanel__scroll">
      <section className="vpanel__sec"><div className="eylab">Zoom</div><div className="row gap2"><button className="chip" type="button" onClick={() => setZoom((current) => zoomBy(current, -0.25))} disabled={zoom.scale <= 1} aria-label="Zoom out">−</button><span className="muted" aria-live="polite">{Math.round(zoom.scale * 100)}%</span><button className="chip" type="button" onClick={() => setZoom((current) => zoomBy(current, 0.25))} disabled={zoom.scale >= 4} aria-label="Zoom in">+</button><button className="chip" type="button" onClick={resetZoom} disabled={zoom.scale === 1 && zoom.panX === 0 && zoom.panY === 0}>Reset</button></div><div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{canAnnotate ? "Use the zoom buttons above; drag draws on the image." : "Scroll to zoom; drag a zoomed image to pan."}</div></section>
      {band !== "phone" && collectionKind === "edited" && rawCompareAsset && <section className="vpanel__sec"><div className="eylab">RAW ↔ Edited</div><button className={`dbtn ${compareActive ? "is-on" : ""}`} style={{ width: "100%" }} type="button" onClick={() => { resetZoom(); setShowRawCompare((current) => !current); }}>{compareActive ? "Hide RAW comparison" : "Compare with RAW"}</button></section>}
      {canReview && <section className="vpanel__sec"><div className="eylab">Decision</div><div className="decide"><button className={`dbtn on-approve ${asset.review?.decision === "approved" ? "is-on" : ""}`} type="button" onClick={() => void onReview(asset.id, { decision: asset.review?.decision === "approved" ? null : "approved" })}>✓ Approve</button><button className={`dbtn on-flag ${asset.review?.decision === "flagged" ? "is-on" : ""}`} type="button" onClick={() => void onReview(asset.id, { decision: asset.review?.decision === "flagged" ? null : "flagged" })}>⚑ Flag</button></div></section>}
      {canRecommend && <section className="vpanel__sec"><div className="eylab">Recommendation</div><button className={`dbtn ${asset.review?.recommended ? "is-on" : ""}`} style={{ width: "100%" }} type="button" onClick={() => void onReview(asset.id, { recommended: !asset.review?.recommended })}>{asset.review?.recommended ? "Recommended to QA" : "Recommend to QA"}</button></section>}
      {canReview && <section className="vpanel__sec"><div className="eylab">Rating</div><div className="starpick">{[1, 2, 3, 4, 5].map((number) => <button key={number} type="button" className={number <= stars ? "on" : ""} onClick={() => void onReview(asset.id, { stars: number === stars ? null : number })}>★</button>)}</div></section>}
      {canReview && <section className="vpanel__sec"><div className="eylab">Label</div><div className="labels">{labels.map((label) => <button className={`labelpick ${asset.review?.colorLabel === label.value ? "is-on" : ""}`} type="button" key={label.value} style={{ background: label.color }} title={label.name} onClick={() => void onReview(asset.id, { colorLabel: asset.review?.colorLabel === label.value ? null : label.value })} />)}</div></section>}
      <section className="vpanel__sec"><div className="eylab" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span>Markup & annotations</span><span style={{ display: "flex", gap: 6 }}><button className="chip" type="button" onClick={() => setMarkupVisible((current) => !current)}>{markupVisible ? "Hide markup" : "Show markup"}</button></span></div>{canAnnotate && <><textarea className="annotation-note" placeholder="Optional note for this markup…" value={annotationNote} disabled={editingDrawingId !== null || editingAnnotationId !== null} onChange={(event) => setAnnotationNote(event.target.value)} /><button className="dbtn" style={{ width: "100%", marginTop: 8 }} type="button" disabled={isSaving || editingDrawingId !== null || (!strokes.length && !annotationNote.trim())} onClick={() => void saveAnnotation()}>Save annotation</button></>}<div className="thread" style={{ marginTop: 14 }}>{annotations.length === 0 ? <div className="muted" style={{ fontSize: 14 }}>No annotations yet.</div> : annotations.map((annotation) => <div className={`cmt ${highlightedAnnotationId === annotation.id ? "cmt--highlighted" : ""}`} key={annotation.id} ref={(el) => { if (el) annotationRefs.current.set(annotation.id, el); else annotationRefs.current.delete(annotation.id); }}><div className="cmt__pin">✎</div><div className="cmt__b"><div className="cmt__who">{annotation.author.name}<span>{annotation.author.role}</span></div>{editingAnnotationId === annotation.id ? <><textarea className="annotation-note" aria-label="Edit annotation note" value={editingAnnotationNote} disabled={isSaving} onChange={(event) => setEditingAnnotationNote(event.target.value)} /><div className="spread" style={{ marginTop: 6 }}><button className="comment-reply" type="button" disabled={isSaving} onClick={cancelInlineEdit}>Cancel</button><button className="comment-reply" type="button" disabled={isSaving} onClick={() => void saveAnnotationEdit()}>Save</button></div></> : <>{annotation.noteText && <div className="cmt__txt">{annotation.noteText}</div>}<div className="ey muted" style={{ marginTop: 6 }}>{time(annotation.createdAt)}{annotation.editedAt && " · (edited)"}{annotation.authorId === currentUserId && <> · <button className="comment-reply" type="button" disabled={hasDraftMarkup || isSaving} onClick={() => { setEditingAnnotationId(annotation.id); setEditingAnnotationNote(annotation.noteText ?? ""); }}>Edit note</button> · <button className="comment-reply" type="button" disabled={hasDraftMarkup || isSaving || !strokesReady(annotation)} title={!strokesReady(annotation) ? "Loading markup…" : undefined} onClick={() => startDrawingEdit(annotation)}>{annotation.strokeR2Key ? "Edit drawing" : "Add drawing"}</button> · <button className="comment-reply" type="button" disabled={hasDraftMarkup || isSaving} onClick={() => void deleteAnnotation(annotation)}>Delete</button></>}</div></>}</div></div>)}</div></section>
    </div></> : null}</aside>
    <div className="strip">{assets.map((item, itemIndex) => <FilmstripThumbnail key={item.id} asset={item} active={itemIndex === displayIndex} onSelect={() => { if (hasDraftMarkup && !window.confirm("Discard the current unsaved markup?")) return; activeAssetIdRef.current = item.id; setIndex(itemIndex); }} />)}</div>
  </div>;
}
