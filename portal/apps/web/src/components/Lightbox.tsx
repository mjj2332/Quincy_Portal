import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { useSession } from "../lib/auth";
import type { ReviewPatch, WorkspaceAsset } from "./PhotoGrid";
import { LazyImage } from "./LazyImage";
import { clampZoom, initialZoom, panBy, zoomBy, type ZoomBounds, type ZoomTransform } from "../lib/lightbox-zoom";
import { cycleLightboxIndex } from "../lib/lightbox-navigation";
import { useLightboxNeighborPreload } from "../lib/lightbox-neighbor-preload";
import { confirm } from "../lib/confirm";
import { cn } from "../lib/utils";
import { IconButton, ICON_BUTTON, ICON_BUTTON_BASE } from "./ui/icon-button";
import { buttonClasses } from "./ui/button";
import { Eyebrow, META_TEXT } from "./ui/eyebrow";
import { Textarea } from "./ui/textarea";
import { REVIEW_LABELS } from "./lightbox/review-labels";

// TB8-09 slice 2: the stage's keyboard-shortcut pill. Three sites of each,
// pulled into constants so the `.viewer__shortcuts` variants below (with vs.
// without a review shortcut list) don't drift from each other.
const SHORTCUT_KBD =
  "kbd inline-grid place-items-center min-w-[17px] px-[var(--space-1)] rounded-[var(--radius-xs)] " +
  "border border-solid border-[length:var(--border-width-hair)] border-border bg-secondary text-foreground " +
  "[font:var(--type-mono)] text-[length:var(--text-2xs)]";
const SHORTCUT_ITEM = "inline-flex items-center gap-[var(--space-1)]";
const SHORTCUT_SEP = "not-italic text-on-inverse-muted";

// TB8-09 slice 3: the markup toolbar's pen-colour swatches carried no accessible name at
// all — this is the map that gives each of the six a real one. The hex values themselves
// stay literals (§1.5): they are pen ink applied to the photograph, not interface chrome.
export const PEN_COLOUR_NAMES = {
  "#e64b3c": "Red", "#f0a020": "Amber", "#3f8f5a": "Green",
  "#2f6df0": "Blue", "#ffffff": "White", "#0a0a0a": "Black",
} as const;

// TB8-09 slice 4: every `.vpanel__sec` heading takes PANEL_SECTION on the <section> element.
// Six of the seven become <Eyebrow>; "Markup & annotations" is a flex row holding a heading
// AND a button, so it keeps its own element and takes SECTION_LABEL instead (§5.9b).
const PANEL_SECTION = "vpanel__sec";
const SECTION_LABEL =
  "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary mb-[var(--space-3)]";

// Five rating buttons, not a radio group (§0c): clicking the set value clears it, which radio
// semantics cannot express. Paint is cumulative (n <= stars) but aria-pressed is not (n ===
// stars) — the two conditions are deliberately different (§5.4). §9 decision 1 is binding: the
// off state reads text-foreground-secondary, NOT text-muted-foreground (the star glyph is text).
// The star's size is set by overriding the WHOLE `font` shorthand, not by adding a
// `text-[length:…]` next to it. `ICON_BUTTON_BASE` already carries
// `[font:…var(--text-md)…]`, and two utilities touching `font-size` are resolved by Tailwind's
// emission order, not by class order — the split form rendered 18px, silently shrinking the
// stars from the 22px they had before this release. `button.tsx` documents this exact trap
// against `--type-label`; the fix there and here is one explicit shorthand. Caught by the
// visual gate, after 1,763 tests and two review rounds passed it. (TB8-09 §5.4.)
const RATING_BUTTON =
  ICON_BUTTON_BASE + " w-[28px] max-[721px]:w-[44px] leading-none " +
  "[font:var(--weight-regular)_var(--text-lg)/1_var(--font-sans)]";
const RATING_ON = "text-signal-caution-text";
const RATING_OFF = "text-foreground-secondary";

// TB8-09 slice 5: the filmstrip thumbnail. `.strip__t`'s hover paint depends on the button's
// hover state, so the button carries `group` and the thumb reads it via `group-hover`; the
// active-outline half is a JS-computed boolean, not a pseudo-class, so it's applied directly.
// `outline: 2px solid transparent` is DELETED, not carried forward (§3.1) — it was one of two
// independent causes tying `:focus-visible` on specificity with `app.css` importing after
// `tokens/base.css`. The focus utilities below copy `ICON_BUTTON_BASE`'s established pattern.
const STRIP_BUTTON =
  "strip__button group flex-none w-[84px] h-[56px] p-0 border-0 bg-transparent leading-none cursor-pointer " +
  "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2 " +
  "max-[721px]:w-[60px] max-[721px]:h-[44px]";
const STRIP_THUMB =
  "strip__t block w-[84px] h-[56px] object-cover bg-[var(--ink-700)] transition-opacity " +
  "duration-[var(--dur-fast)] max-[721px]:w-[60px] max-[721px]:h-[44px]";

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

function FilmstripThumbnail({ asset, active, onSelect }: { asset: WorkspaceAsset; active: boolean; onSelect: (event: React.MouseEvent<HTMLButtonElement>) => void }) {
  const [failed, setFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  function activate(event: React.MouseEvent<HTMLButtonElement>) { if (failed) { setFailed(false); setRetryToken((current) => current + 1); } else onSelect(event); }
  return <button className={cn(STRIP_BUTTON, active && "is-active")} type="button" onClick={activate} title={failed ? `Retry ${asset.originalFilename}` : asset.originalFilename} aria-label={failed ? `Retry thumbnail for ${asset.originalFilename}` : asset.originalFilename}><LazyImage className={cn(STRIP_THUMB, active ? "opacity-100 outline outline-[length:var(--border-width-bold)] outline-solid outline-[var(--ring)]" : "opacity-50 group-hover:opacity-85")} preload="background" assetId={asset.id} alt={asset.originalFilename} retryToken={retryToken} onFailedChange={setFailed} /></button>;
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
  const move = async (change: number, event?: { preventDefault: () => void; stopPropagation: () => void }) => {
    event?.preventDefault();
    event?.stopPropagation();
    if (hasDraftMarkup && !await confirm({ title: "Discard unsaved markup?", message: "Discard the current unsaved markup?", confirmLabel: "Discard", danger: true })) return;
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
      if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); void move(-1, event); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); void move(1, event); return; }
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
  async function drawDown(event: React.PointerEvent<SVGSVGElement>) {
    if (!canAnnotate) return;
    event.preventDefault();
    event.stopPropagation();
    if (strokes.length === 0 && editingDrawingId === null && editingAnnotationId !== null) {
      if (!await confirm({ title: "Discard note edit?", message: "Discard the note edit in progress?", confirmLabel: "Discard", danger: true })) return;
      // The original pointer gesture may have ended while the modal was open. Do not
      // synthesize a point or resume pointer capture; the next fresh gesture draws.
      cancelInlineEdit();
      return;
    }
    drawingRef.current = true;
    setStrokes((current) => [...current, { color: tool.color, width: tool.width, points: [pointerPoint(event)] }]);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
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
    if (!await confirm({ title: "Delete annotation?", message: annotation.strokeR2Key ? "Delete this annotation and its markup?" : "Delete this annotation?", confirmLabel: "Delete", danger: true })) return;
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
    void move(dx < 0 ? 1 : -1, event);
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
  async function closeViewer(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();
    event?.stopPropagation();
    if (hasDraftMarkup && !await confirm({ title: "Discard unsaved markup?", message: "Discard the current unsaved markup?", confirmLabel: "Discard", danger: true })) return;
    onClose();
  }
  async function selectFilmstrip(index: number, event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (hasDraftMarkup && !await confirm({ title: "Discard unsaved markup?", message: "Discard the current unsaved markup?", confirmLabel: "Discard", danger: true })) return;
    const nextAsset = assets[index];
    if (!nextAsset) return;
    activeAssetIdRef.current = nextAsset.id;
    setIndex(index);
  }
  const editedStage = <div className="viewer__stage row-start-1 row-end-2 relative grid place-items-center overflow-hidden min-w-0"><IconButton className="viewer__close absolute top-[16px] left-[16px] z-[5] max-[721px]:top-[calc(16px+env(safe-area-inset-top))] max-[721px]:left-[max(16px,env(safe-area-inset-left))]" type="button" onClick={(event) => { void closeViewer(event); }} aria-label="Close">×</IconButton><button ref={reviewTriggerRef} className={buttonClasses("secondary", { className: "viewer__panel-trigger absolute top-[16px] right-[16px] z-[5] hidden max-[1081px]:inline-flex max-[721px]:!hidden" })} type="button" onClick={(event) => openPanel(event.currentTarget)} aria-expanded={panelOpen} aria-controls="lightbox-review-panel">Review</button><div className="viewer__meta absolute top-[16px] left-1/2 -translate-x-1/2 z-[4] text-center text-foreground max-[721px]:top-[calc(18px+env(safe-area-inset-top))] max-[721px]:max-w-[45vw]"><div className="a [font:var(--type-h3)] [font-family:var(--font-display)] max-[721px]:hidden">{asset.originalFilename}</div><Eyebrow className="b mt-[3px] text-on-inverse-muted max-[721px]:mt-0">{collectionKind === "edited" ? "Edited" : "RAW"} · Frame {displayIndex + 1} of {assets.length}</Eyebrow></div><IconButton className="viewer__nav prev absolute top-1/2 -translate-y-1/2 z-[3] left-[18px] max-[721px]:left-[10px]" type="button" onClick={(event) => { void move(-1, event); }} aria-label="Previous frame">←</IconButton><div className="viewer__imgwrap relative w-full h-full grid place-items-center overflow-hidden p-[28px] pb-[84px] max-[721px]:pt-[calc(28px+env(safe-area-inset-top))] max-[721px]:pb-[118px]"><div className={`canvasframe canvasframe--zoomable ${zoom.scale > 1 && !canAnnotate ? "is-zoomed" : ""}`} ref={frameRef} style={zoomStyleFor(frameRef)} onPointerDown={(event) => { startPan(event); startSwipe(event); }} onPointerMove={(event) => { movePan(event); moveSwipe(event); }} onPointerUp={(event) => { endSwipe(event); endPan(event); }} onPointerCancel={(event) => { swipeRef.current = null; endPan(event); }} onWheel={wheelZoom} onTouchStart={touchStartZoom} onTouchMove={touchMoveZoom} onTouchEnd={touchEndZoom}><img className="viewer__img max-w-full max-h-full object-contain select-none" draggable={false} onDragStart={(event) => event.preventDefault()} src={`/media/asset/${encodeURIComponent(asset.id)}/web`} alt={asset.originalFilename} />{drawLayer}</div></div><IconButton className="viewer__nav next absolute top-1/2 -translate-y-1/2 z-[3] right-[18px] max-[721px]:right-[10px]" type="button" onClick={(event) => { void move(1, event); }} aria-label="Next frame">→</IconButton><div className={cn("viewer__shortcuts absolute inset-x-0 mx-auto w-max z-[4] flex items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-1)] rounded-[var(--radius-pill)] border border-solid border-[length:var(--border-width-hair)] border-border bg-[var(--scrim-overlay)] text-on-inverse-muted [font:var(--type-eyebrow)] tracking-[var(--tracking-wide)] whitespace-nowrap pointer-events-none max-[721px]:hidden", canAnnotate ? cn("bottom-[82px]", hasDraftMarkup && "is-drawing") : "bottom-[18px]")} aria-hidden="true">{hasDraftMarkup ? <><span className={SHORTCUT_ITEM}><kbd className={SHORTCUT_KBD}>⌘Z</kbd> undo</span><i className={SHORTCUT_SEP}>·</i><span className={SHORTCUT_ITEM}><kbd className={SHORTCUT_KBD}>Esc</kbd> done</span></> : <><span className={SHORTCUT_ITEM}><kbd className={SHORTCUT_KBD}>←</kbd><kbd className={SHORTCUT_KBD}>→</kbd> frames</span>{canReview && <><i className={SHORTCUT_SEP}>·</i><span className={SHORTCUT_ITEM}><kbd className={SHORTCUT_KBD}>A</kbd> approve</span><i className={SHORTCUT_SEP}>·</i><span className={SHORTCUT_ITEM}><kbd className={SHORTCUT_KBD}>X</kbd> flag</span><i className={SHORTCUT_SEP}>·</i><span className={SHORTCUT_ITEM}><kbd className={SHORTCUT_KBD}>1–5</kbd> rate</span><i className={SHORTCUT_SEP}>·</i><span className={SHORTCUT_ITEM}><kbd className={SHORTCUT_KBD}>0</kbd> clear</span></>}<i className={SHORTCUT_SEP}>·</i><span className={SHORTCUT_ITEM}><kbd className={SHORTCUT_KBD}>Esc</kbd> close</span></>}</div>
    {canAnnotate && <div className="drawbar absolute inset-x-0 bottom-[18px] mx-auto w-max z-[6] flex items-center flex-wrap gap-[var(--space-3)] py-[var(--space-2)] pr-[var(--space-2)] pl-[var(--space-4)] bg-card border border-solid border-[length:var(--border-width-hair)] border-border rounded-[var(--radius-pill)] shadow-[var(--shadow-lg)] text-foreground max-w-[calc(100%-32px)] max-[721px]:bottom-[calc(18px+env(safe-area-inset-bottom))] max-[721px]:max-w-[calc(100%-16px)] max-[721px]:gap-[var(--space-2)]"><Eyebrow className="drawbar__lbl text-on-inverse-muted">{editingDrawingId ? "Editing drawing" : "Markup"}</Eyebrow><div role="group" aria-label="Pen colour" className="drawbar__grp inline-flex items-center gap-[var(--space-2)] px-[var(--space-1)]">{(Object.keys(PEN_COLOUR_NAMES) as (keyof typeof PEN_COLOUR_NAMES)[]).map((color) => <button key={color} type="button" className={cn(ICON_BUTTON, "swatch rounded-full", tool.color === color && "outline outline-[length:var(--border-width-bold)] outline-solid outline-[var(--ring)] outline-offset-2")} aria-pressed={tool.color === color} aria-label={PEN_COLOUR_NAMES[color]} onClick={() => setTool((current) => ({ ...current, color }))}><span aria-hidden="true" style={{ background: color }} className="w-[19px] h-[19px] rounded-full border border-[length:var(--border-width-hair)] border-solid border-border" /></button>)}</div><div role="group" aria-label="Stroke width" className="drawbar__grp inline-flex items-center gap-[var(--space-2)] px-[var(--space-1)]">{[2, 4, 7].map((width) => <button key={width} type="button" className={cn(ICON_BUTTON, "wbtn", tool.width === width && "bg-secondary")} aria-pressed={tool.width === width} aria-label={`${width} pixels`} onClick={() => setTool((current) => ({ ...current, width }))}><span aria-hidden="true" style={{ width: width + 3, height: width + 3 }} className="block rounded-full bg-foreground" /></button>)}</div><button type="button" className={buttonClasses("secondary")} disabled={!strokes.length} onClick={() => setStrokes((current) => current.slice(0, -1))}>Undo</button><button type="button" className={buttonClasses("secondary")} disabled={!strokes.length} onClick={() => setStrokes([])}>Clear</button>{editingDrawingId && <><button type="button" className={buttonClasses("secondary")} onClick={exitDrawMode}>Cancel</button><button type="button" className={buttonClasses("primary")} disabled={isSaving} onClick={() => void saveDrawingEdit()}>Save</button></>}</div>}
  </div>;

  return <div className={cn(
    "viewer fixed inset-0 z-[80] bg-background grid grid-rows-[1fr_auto]",
    compareActive
      ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_380px] max-[1081px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      : "grid-cols-[1fr_380px] max-[1081px]:grid-cols-[1fr]",
  )} data-surface="inverse" role="dialog" aria-modal="true" aria-label="Photo viewer">
    {compareActive && rawCompareAsset ? <div className="viewer__stage row-start-1 row-end-2 relative grid place-items-center overflow-hidden min-w-0"><div className="viewer__meta absolute top-[16px] left-1/2 -translate-x-1/2 z-[4] text-center text-foreground max-[721px]:top-[calc(18px+env(safe-area-inset-top))] max-[721px]:max-w-[45vw]"><div className="a [font:var(--type-h3)] [font-family:var(--font-display)] max-[721px]:hidden">RAW comparison</div><Eyebrow className="b mt-[3px] text-on-inverse-muted max-[721px]:mt-0">{rawCompareAsset.originalFilename}</Eyebrow></div><div className="viewer__imgwrap relative w-full h-full grid place-items-center overflow-hidden p-[28px] pb-[84px] max-[721px]:pt-[calc(28px+env(safe-area-inset-top))] max-[721px]:pb-[118px]"><div className={`canvasframe canvasframe--zoomable ${zoom.scale > 1 && !canAnnotate ? "is-zoomed" : ""}`} ref={rawFrameRef} style={zoomStyleFor(rawFrameRef)} onPointerDown={(event) => { startPan(event); startSwipe(event); }} onPointerMove={(event) => { movePan(event); moveSwipe(event); }} onPointerUp={(event) => { endSwipe(event); endPan(event); }} onPointerCancel={(event) => { swipeRef.current = null; endPan(event); }} onWheel={wheelZoom} onTouchStart={touchStartZoom} onTouchMove={touchMoveZoom} onTouchEnd={touchEndZoom}><img className="viewer__img max-w-full max-h-full object-contain select-none" draggable={false} onDragStart={(event) => event.preventDefault()} src={`/media/asset/${encodeURIComponent(rawCompareAsset.id)}/web`} alt={`RAW ${rawCompareAsset.originalFilename}`} /></div></div></div> : null}
    {editedStage}
    {panelOpen && band !== "desktop" && <div className="fixed inset-0 z-[5] bg-[var(--scrim-overlay)] backdrop-blur-[2px]" aria-hidden="true" onClick={closePanel} />}
    <aside id="lightbox-review-panel" data-surface="default" className={cn("vpanel row-start-1 row-end-3 bg-background text-foreground border-l border-solid border-[length:var(--border-width-hair)] border-l-[var(--greige-500)] flex flex-col min-h-0 max-[1081px]:fixed max-[1081px]:right-0 max-[1081px]:top-0 max-[1081px]:bottom-0 max-[1081px]:w-[min(420px,90vw)] max-[1081px]:z-[6] max-[1081px]:shadow-[var(--shadow-lg)] max-[1081px]:translate-x-full max-[1081px]:transition-transform max-[1081px]:duration-[var(--dur-slow)] max-[1081px]:ease-[var(--ease-entrance)] max-[1081px]:[&.open]:translate-x-0", panelOpen && "open", compareActive && "col-start-3")}>
      {band === "phone" && !panelOpen ? <div className="vpanel__peek" onClick={(event) => openPanel(event.currentTarget)}>
        <div className="vpanel__peek-actions">
          {canReview && <><button className={`vpanel__peek-action on-approve ${asset.review?.decision === "approved" ? "is-on" : ""}`} type="button" aria-label="Approve" aria-pressed={asset.review?.decision === "approved"} onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { decision: asset.review?.decision === "approved" ? null : "approved" }); }}>✓</button><button className={`vpanel__peek-action on-flag ${asset.review?.decision === "flagged" ? "is-on" : ""}`} type="button" aria-label="Flag" aria-pressed={asset.review?.decision === "flagged"} onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { decision: asset.review?.decision === "flagged" ? null : "flagged" }); }}>⚑</button><button className="vpanel__peek-action vpanel__peek-rating" type="button" aria-label={stars ? `Rating ${stars} of 5. Change rating` : "Set rating"} onClick={(event) => { event.stopPropagation(); void onReview(asset.id, { stars: stars >= 5 ? null : stars + 1 }); }}>★<span>{stars || "—"}</span></button></>}
        </div>
        <button ref={peekHandleRef} className="vpanel__peek-handle" type="button" onClick={(event) => { event.stopPropagation(); openPanel(event.currentTarget); }} aria-expanded={panelOpen} aria-controls="lightbox-review-panel"><span aria-hidden="true">⌃</span><span>Review</span></button>
      </div> : (panelOpen || band === "desktop") ? <>
        <div className="vpanel__head relative p-[var(--space-6)] pb-[var(--space-5)] border-b border-solid border-[length:var(--border-width-hair)] border-border"><div className="ey" style={{ marginBottom: 8 }}>{collectionKind === "edited" ? "Edited QA" : "RAW capture"} · {asset.width ?? "—"} × {asset.height ?? "—"}</div><div className="vpanel__addr serif [font:var(--type-h3)] tracking-[var(--tracking-tight)] leading-[1.15]">{asset.originalFilename}</div>{band !== "desktop" && <button ref={collapseButtonRef} type="button" data-slot="icon-button" className={cn(ICON_BUTTON, "vpanel__collapse absolute top-[var(--space-4)] right-[var(--space-4)] min-h-[36px] min-w-[36px]")} onClick={closePanel} aria-label="Collapse review panel" aria-expanded={panelOpen} aria-controls="lightbox-review-panel">⌄</button>}</div><div className="vpanel__scroll overflow-auto flex-1 px-[var(--space-6)] py-[var(--space-5)] flex flex-col gap-[var(--space-5)]">
      <section className={PANEL_SECTION}><Eyebrow className="eylab mb-[var(--space-3)]">Zoom</Eyebrow><div className="row gap2"><IconButton type="button" onClick={() => setZoom((current) => zoomBy(current, -0.25))} disabled={zoom.scale <= 1} aria-label="Zoom out">−</IconButton><span className="muted" aria-live="polite">{Math.round(zoom.scale * 100)}%</span><IconButton type="button" onClick={() => setZoom((current) => zoomBy(current, 0.25))} disabled={zoom.scale >= 4} aria-label="Zoom in">+</IconButton><button className={buttonClasses("secondary")} type="button" onClick={resetZoom} disabled={zoom.scale === 1 && zoom.panX === 0 && zoom.panY === 0}>Reset</button></div><div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{canAnnotate ? "Use the zoom buttons above; drag draws on the image." : "Scroll to zoom; drag a zoomed image to pan."}</div></section>
      {band !== "phone" && collectionKind === "edited" && rawCompareAsset && <section className={PANEL_SECTION}><Eyebrow className="eylab mb-[var(--space-3)]">RAW ↔ Edited</Eyebrow><button className={cn("dbtn", buttonClasses(compareActive ? "primary" : "secondary", { className: "w-full" }))} type="button" aria-pressed={compareActive} onClick={() => { resetZoom(); setShowRawCompare((current) => !current); }}>{compareActive ? "Hide RAW comparison" : "Compare with RAW"}</button></section>}
      {canReview && <section className={PANEL_SECTION}><Eyebrow className="eylab mb-[var(--space-3)]">Decision</Eyebrow><div className="decide grid grid-cols-2 gap-[var(--space-2)]"><button className={cn("dbtn on-approve", buttonClasses(asset.review?.decision === "approved" ? "primary" : "secondary", { className: "w-full" }))} type="button" aria-pressed={asset.review?.decision === "approved"} onClick={() => void onReview(asset.id, { decision: asset.review?.decision === "approved" ? null : "approved" })}>✓ Approve</button><button className={cn("dbtn on-flag", buttonClasses(asset.review?.decision === "flagged" ? "danger" : "secondary", { className: "w-full" }))} type="button" aria-pressed={asset.review?.decision === "flagged"} onClick={() => void onReview(asset.id, { decision: asset.review?.decision === "flagged" ? null : "flagged" })}>⚑ Flag</button></div></section>}
      {canRecommend && <section className={PANEL_SECTION}><Eyebrow className="eylab mb-[var(--space-3)]">Recommendation</Eyebrow><button className={cn("dbtn", buttonClasses(asset.review?.recommended ? "primary" : "secondary", { className: "w-full" }))} type="button" aria-pressed={Boolean(asset.review?.recommended)} onClick={() => void onReview(asset.id, { recommended: !asset.review?.recommended })}>{asset.review?.recommended ? "Recommended to QA" : "Recommend to QA"}</button></section>}
      {canReview && <section className={PANEL_SECTION}><Eyebrow className="eylab mb-[var(--space-3)]">Rating</Eyebrow><div role="group" aria-label="Rating" className="starpick flex gap-[var(--space-1)]">{[1, 2, 3, 4, 5].map((number) => <button key={number} type="button" aria-pressed={number === stars} aria-label={`${number} star${number === 1 ? "" : "s"}`} className={cn(RATING_BUTTON, number <= stars ? RATING_ON : RATING_OFF)} onClick={() => void onReview(asset.id, { stars: number === stars ? null : number })}>★</button>)}</div></section>}
      {canReview && <section className={PANEL_SECTION}><Eyebrow className="eylab mb-[var(--space-3)]">Label</Eyebrow><div role="group" aria-label="Colour label" className="labels flex gap-[var(--space-3)]">{REVIEW_LABELS.map((label) => <button className={cn(ICON_BUTTON_BASE, "labelpick w-[28px] max-[721px]:w-[44px] rounded-full", asset.review?.colorLabel === label.value && "outline outline-[length:var(--border-width-bold)] outline-solid outline-[var(--ring)] outline-offset-2")} type="button" key={label.value} aria-pressed={asset.review?.colorLabel === label.value} aria-label={label.name} title={label.name} onClick={() => void onReview(asset.id, { colorLabel: asset.review?.colorLabel === label.value ? null : label.value })}><span aria-hidden="true" style={{ background: label.color }} className="w-[26px] h-[26px] rounded-full border border-[length:var(--border-width-hair)] border-solid border-border" /></button>)}</div></section>}
      <section className={PANEL_SECTION}><div className={cn("eylab", SECTION_LABEL, "flex justify-between items-center")}><span>Markup & annotations</span><span style={{ display: "flex", gap: 6 }}><button className="chip" type="button" onClick={() => setMarkupVisible((current) => !current)}>{markupVisible ? "Hide markup" : "Show markup"}</button></span></div>{canAnnotate && <><Textarea className="annotation-note mt-[var(--space-3)]" placeholder="Optional note for this markup…" value={annotationNote} disabled={editingDrawingId !== null || editingAnnotationId !== null} onChange={(event) => setAnnotationNote(event.target.value)} /><button className={cn("dbtn", buttonClasses("primary", { className: "w-full mt-[var(--space-2)]" }))} type="button" disabled={isSaving || editingDrawingId !== null || (!strokes.length && !annotationNote.trim())} onClick={() => void saveAnnotation()}>Save annotation</button></>}<div className="thread flex flex-col gap-[var(--space-4)]" style={{ marginTop: 14 }}>{annotations.length === 0 ? <div className="muted" style={{ fontSize: 14 }}>No annotations yet.</div> : annotations.map((annotation) => <div className={cn("cmt flex gap-[var(--space-3)] rounded-[var(--radius-sm)] transition-[background-color] duration-[1600ms] ease-[var(--ease-standard)]", highlightedAnnotationId === annotation.id && "cmt--highlighted bg-surface-sunken")} key={annotation.id} ref={(el) => { if (el) annotationRefs.current.set(annotation.id, el); else annotationRefs.current.delete(annotation.id); }}><div aria-hidden="true" className={cn("cmt__pin flex-none w-[22px] h-[22px] rounded-full bg-primary text-primary-foreground grid place-items-center [font:var(--type-mono)] text-[length:var(--text-2xs)] mt-[2px]")}>✎</div><div className="cmt__b flex-1 min-w-0"><div className="cmt__who [font:var(--type-label)]">{annotation.author.name}<span className={cn(META_TEXT, "ml-[var(--space-2)]")}>{annotation.author.role}</span></div>{editingAnnotationId === annotation.id ? <><Textarea className="annotation-note mt-[var(--space-3)]" aria-label="Edit annotation note" value={editingAnnotationNote} disabled={isSaving} onChange={(event) => setEditingAnnotationNote(event.target.value)} /><div className="spread" style={{ marginTop: 6 }}><button className={cn("comment-reply", buttonClasses("text", { className: "underline min-w-[44px] max-[721px]:min-h-[44px] px-[var(--space-1)]" }))} type="button" disabled={isSaving} onClick={cancelInlineEdit}>Cancel</button><button className={cn("comment-reply", buttonClasses("text", { className: "underline min-w-[44px] max-[721px]:min-h-[44px] px-[var(--space-1)]" }))} type="button" disabled={isSaving} onClick={() => void saveAnnotationEdit()}>Save</button></div></> : <>{annotation.noteText && <div className="cmt__txt text-[length:var(--text-sm)] leading-[var(--leading-normal)] mt-[3px] text-foreground-secondary">{annotation.noteText}</div>}<div className="ey muted" style={{ marginTop: 6 }}>{time(annotation.createdAt)}{annotation.editedAt && " · (edited)"}{annotation.authorId === currentUserId && <> <span aria-hidden="true">·</span> <button className={cn("comment-reply", buttonClasses("text", { className: "underline min-w-[44px] max-[721px]:min-h-[44px] px-[var(--space-1)]" }))} type="button" disabled={hasDraftMarkup || isSaving} onClick={() => { setEditingAnnotationId(annotation.id); setEditingAnnotationNote(annotation.noteText ?? ""); }}>Edit note</button> <span aria-hidden="true">·</span> <button className={cn("comment-reply", buttonClasses("text", { className: "underline min-w-[44px] max-[721px]:min-h-[44px] px-[var(--space-1)]" }))} type="button" disabled={hasDraftMarkup || isSaving || !strokesReady(annotation)} title={!strokesReady(annotation) ? "Loading markup…" : undefined} onClick={() => startDrawingEdit(annotation)}>{annotation.strokeR2Key ? "Edit drawing" : "Add drawing"}</button> <span aria-hidden="true">·</span> <button className={cn("comment-reply", buttonClasses("text", { className: "underline min-w-[44px] max-[721px]:min-h-[44px] px-[var(--space-1)]" }))} type="button" disabled={hasDraftMarkup || isSaving} onClick={() => void deleteAnnotation(annotation)}>Delete</button></>}</div></>}</div></div>)}</div></section>
    </div></> : null}</aside>
    <div className={cn(
      "strip col-start-1 col-end-2 row-start-2 row-end-3 flex min-w-0 gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)] overflow-x-auto bg-[var(--scrim-overlay)] border-t border-solid border-[length:var(--border-width-hair)] border-border",
      compareActive && "col-start-1 col-end-3",
    )}>{assets.map((item, itemIndex) => <FilmstripThumbnail key={item.id} asset={item} active={itemIndex === displayIndex} onSelect={(event) => { void selectFilmstrip(itemIndex, event); }} />)}</div>
  </div>;
}
