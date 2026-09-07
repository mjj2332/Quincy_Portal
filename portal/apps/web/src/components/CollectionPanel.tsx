import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { WorkspaceAsset } from "./PhotoGrid";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPostWithStatus } from "../lib/api";
import { useSession } from "../lib/auth";
import { externalApiGet } from "../lib/external-api-response";
import { uploadMultipartFile, type MultipartPresign } from "../lib/multipart-upload";
import { invalidateProjectSurfaces, useOptionalProjectQueryClient, useProjectAccessTermination } from "../lib/project-data";
import { LazyImage } from "./LazyImage";
import { reorderNeighbors } from "../lib/reorder-neighbors";
import { confirm } from "../lib/confirm";
import { buttonClasses } from "./ui/button";
import { cn } from "../lib/utils";
import { RAIL_FIELD } from "../lib/rail-field";

type CollectionKind = "video" | "floorplan" | "copy";
type Link = { id: string; url: string; label: string | null; source: "tonomo" | "manual"; position: number; createdAt: string };
type DocumentPresign = { sessionId: string; kind: "copy_pdf" | "floorplan"; versionGroupId: string; version: number; files: { pdf: MultipartPresign & { assetId: string }; preview?: MultipartPresign & { assetId: string } } };

function formatDate(value: string) { return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)); }
function httpsUrl(value: string): URL | null { try { const url = new URL(value); return url.protocol === "https:" ? url : null; } catch { return null; } }
function isHost(host: string, domain: string) { return host === domain || host.endsWith(`.${domain}`); }
function hostLabel(url: string) { const parsed = httpsUrl(url); if (!parsed) return "Link"; const host = parsed.hostname.replace(/^www\./, ""); if (isHost(host, "vimeo.com")) return "Vimeo"; if (isHost(host, "dropbox.com")) return "Dropbox"; return host; }
function assetUrl(asset: WorkspaceAsset) { return `/media/asset/${encodeURIComponent(asset.id)}/original`; }
function isPdf(file: File) { return file.type === "application/pdf"; }
function isJpeg(file: File) { return file.type === "image/jpeg"; }

const LINK_BODY =
  "flex items-start justify-between gap-[var(--space-3)] min-w-0 " +
  "text-foreground no-underline " +
  "[.collection-links--video_&]:flex-col [.collection-links--video_&]:items-start";

const LINK_FORM_BASE = "collection-link-form grid grid-cols-1 gap-[var(--space-3)] items-end min-w-0";

const LINK_FORM_LABEL =
  "grid gap-[var(--space-1)] min-w-0 " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

const LINK_GRIP =
  "collection-link__grip grid place-items-center shrink-0 " +
  "min-w-[44px] min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "border-0 bg-transparent text-foreground-secondary cursor-grab [touch-action:none] " +
  "hover:text-foreground active:cursor-grabbing " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "aria-disabled:cursor-default aria-disabled:opacity-[.5]";

const LINK_ERROR_TEXT =
  "m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-[color:var(--signal-critical)]";

function DocumentPreview({ preview, latest }: { preview: WorkspaceAsset; latest: WorkspaceAsset }) {
  const [failed, setFailed] = useState(false); const [retryToken, setRetryToken] = useState(0);
  return <a className="document-preview" href={assetUrl(latest)} target="_blank" rel="noreferrer" aria-label={failed ? `Retry preview of ${latest.originalFilename}` : undefined} onClick={(event) => { if (!failed) return; event.preventDefault(); setFailed(false); setRetryToken((current) => current + 1); }}><LazyImage src={assetUrl(preview)} alt={`Preview of ${latest.originalFilename}`} retryToken={retryToken} onFailedChange={setFailed} /></a>;
}

function LinkTile({ link, sortable = false, busy = false, onRemove, onEdit, editingLinkId, editDraft, editError, savingEdit, onEditDraftChange, onSaveEdit, onCancelEdit }: {
  link: Link; sortable?: boolean; busy?: boolean; onRemove?: (link: Link) => void; onEdit?: (link: Link) => void; editingLinkId?: string | null;
  editDraft?: { url: string; label: string }; editError?: string; savingEdit?: boolean;
  onEditDraftChange?: (draft: { url: string; label: string }) => void; onSaveEdit?: (event: FormEvent) => void; onCancelEdit?: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: link.id, disabled: !sortable || busy });
  const safeUrl = httpsUrl(link.url); const title = link.label || hostLabel(link.url);
  const content = <><span className="collection-link__name [font:var(--weight-regular)_var(--text-lg)/var(--leading-snug)_var(--font-display)] tracking-[var(--tracking-tight)] text-foreground [overflow-wrap:anywhere]" data-testid="collection-link-name">{title}</span><span className="chip" data-testid="collection-link-source">{hostLabel(link.url)}</span></>;
  const isEditing = editingLinkId === link.id;
  const errorId = `collection-link-edit-error-${link.id}`;
  const dragProps = { ...attributes, ...listeners, ...(busy ? { "aria-disabled": true } : {}) };
  return <div ref={sortable ? setNodeRef : undefined} style={sortable ? { transform: CSS.Transform.toString(transform), transition } : undefined} data-testid="collection-link" className={cn(
    "collection-link flex flex-col justify-between min-h-[var(--space-10)] p-[var(--space-4)]",
    "bg-card border-solid border-[length:var(--border-width-hair)] border-border rounded-none",
    isDragging && "opacity-[.45] border-[color:var(--border-strong)]",
  )}>{isEditing && editDraft && onEditDraftChange && onSaveEdit && onCancelEdit ? <form className={cn(LINK_FORM_BASE, "collection-link-editor p-0 border-0 bg-transparent")} data-testid="collection-link-editor" onSubmit={onSaveEdit}><label className={LINK_FORM_LABEL}><span>Label <em className="not-italic text-foreground-secondary">optional</em></span><input className={RAIL_FIELD} aria-describedby={editError ? errorId : undefined} placeholder="Final walkthrough" value={editDraft.label} onChange={(event) => onEditDraftChange({ ...editDraft, label: event.target.value })} /></label><label className={LINK_FORM_LABEL}><span>Link URL</span><input className={RAIL_FIELD} required type="url" aria-describedby={editError ? errorId : undefined} placeholder="https://vimeo.com/…" value={editDraft.url} onChange={(event) => onEditDraftChange({ ...editDraft, url: event.target.value })} /></label>{editError && <p id={errorId} className={cn("collection-link-editor__error", LINK_ERROR_TEXT)} role="alert">{editError}</p>}<div className="collection-link-editor__actions flex flex-wrap gap-[var(--space-2)]"><button className={buttonClasses("primary", { className: "min-h-[44px]" })} disabled={savingEdit}>{savingEdit ? "Saving…" : "Save"}</button><button className={buttonClasses("secondary", { className: "min-h-[44px]" })} type="button" disabled={savingEdit} onClick={onCancelEdit}>Cancel</button></div></form> : <>{safeUrl ? <a href={safeUrl.href} target="_blank" rel="noopener noreferrer" className={LINK_BODY}>{content}</a> : <div className={cn("collection-link__plain", LINK_BODY)} data-testid="collection-link-plain">{content}</div>}<div className="collection-link__meta flex items-center justify-between gap-[var(--space-2)] mt-[var(--space-4)]" data-testid="collection-link-meta">{sortable && <button ref={setActivatorNodeRef} type="button" className={LINK_GRIP} aria-label={`Reorder ${title}`} {...dragProps}><GripVertical aria-hidden="true" className="size-[var(--space-4)] stroke-[1.5]" /></button>}<span className={cn(
    "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)]",
    link.source === "tonomo" ? "text-[color:var(--signal-caution-text)]" : "text-foreground-secondary",
  )}>{link.source === "tonomo" ? "Tonomo" : "Manual"}</span>{onEdit && link.source === "manual" && <button type="button" className={buttonClasses("text", { className: "ml-auto min-h-[44px]" })} onClick={() => onEdit(link)}>Edit</button>}{onRemove && link.source === "manual" && <button type="button" className={buttonClasses("text", { className: "min-h-[44px]" })} onClick={() => onRemove(link)}>Remove</button>}</div></>}</div>;
}

function LinkTiles({ links, video = false, canReorder = false, reorderingLinkId, onDragEnd, onRemove, onEdit, editingLinkId, editDraft, editError, savingEdit, onEditDraftChange, onSaveEdit, onCancelEdit }: {
  links: Link[]; onRemove?: (link: Link) => void; onEdit?: (link: Link) => void; editingLinkId?: string | null;
  video?: boolean; canReorder?: boolean; reorderingLinkId?: string | null; onDragEnd?: (event: DragEndEvent) => void;
  editDraft?: { url: string; label: string }; editError?: string; savingEdit?: boolean;
  onEditDraftChange?: (draft: { url: string; label: string }) => void; onSaveEdit?: (event: FormEvent) => void; onCancelEdit?: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  if (!links.length) return null;
  const grid = <div className={cn("collection-links grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[var(--space-3)]", video && "collection-links--video")} data-testid="collection-links" data-video={video ? "true" : undefined}>{links.map((link) => <LinkTile key={link.id} link={link} sortable={canReorder && editingLinkId !== link.id} busy={Boolean(reorderingLinkId) || Boolean(editingLinkId)} onEdit={onEdit} onRemove={onRemove} editingLinkId={editingLinkId} editDraft={editDraft} editError={editError} savingEdit={savingEdit} onEditDraftChange={onEditDraftChange} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} />)}</div>;
  if (!canReorder || !onDragEnd) return grid;
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={links.map((link) => link.id)} strategy={rectSortingStrategy}>{grid}</SortableContext></DndContext>;
}

export function CollectionPanel({ projectId, collection, assets, canManage, canDelete = false, canApprove, onReview, onDelete, onChanged, onLinksChanged, onDocumentsChanged, onToast }: {
  projectId: string; collection: CollectionKind; assets: WorkspaceAsset[]; canManage: boolean; canDelete?: boolean; canApprove: boolean;
  onReview: (assetId: string, patch: { decision: "approved" | null }) => Promise<void>; onDelete?: (assetId: string) => Promise<void>; onChanged?: () => Promise<void>; onLinksChanged?: () => Promise<void>; onDocumentsChanged?: (kind: "floorplan" | "copy") => Promise<void>; onToast: (message: string, tone?: "success" | "error") => void;
}) {
  const queryClient = useOptionalProjectQueryClient();
  const session = useSession();
  const external = session.data?.user.role === "external_editor";
  const terminateOnUnauthorized = useProjectAccessTermination();
  const reportLinksChanged = onLinksChanged ?? onChanged ?? (async () => undefined);
  const reportDocumentsChanged = onDocumentsChanged ?? (async () => onChanged?.());
  const [links, setLinks] = useState<Link[]>([]); const [url, setUrl] = useState(""); const [label, setLabel] = useState(""); const [savingLink, setSavingLink] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null); const [editDraft, setEditDraft] = useState({ url: "", label: "" }); const [editError, setEditError] = useState(""); const [savingEdit, setSavingEdit] = useState(false); const [reorderingLinkId, setReorderingLinkId] = useState<string | null>(null);
  const [uploadGroupId, setUploadGroupId] = useState<string | undefined>(); const [uploading, setUploading] = useState(false); const copyInput = useRef<HTMLInputElement>(null); const floorplanInput = useRef<HTMLInputElement>(null);
  const loadToken = useRef(0);
  const loadLinks = useCallback(async () => {
    const token = ++loadToken.current;
    const path = `/api/projects/${projectId}/links?collection=${collection}`;
    const response = external
      ? await externalApiGet("collection-links", path) as { links: Link[] }
      : await apiGet<{ links: Link[] }>(path);
    // A stale response (e.g. the collection tab changed, or an overlapping reorder reload)
    // must not clobber a newer load's result.
    if (loadToken.current === token) setLinks(response.links);
  }, [collection, external, projectId]);
  async function invalidateActivity() {
    if (queryClient) await invalidateProjectSurfaces(queryClient, { projectId, resources: [{ kind: "activity" }], dashboard: false, calendar: false });
  }
  useEffect(() => { let active = true; void loadLinks().catch((error: unknown) => { terminateOnUnauthorized(error); if (active) onToast(error instanceof Error ? error.message : "Delivered links could not be loaded.", "error"); }); return () => { active = false; }; }, [loadLinks, onToast, terminateOnUnauthorized]);
  async function addLink(event: FormEvent) {
    event.preventDefault(); setSavingLink(true);
    try {
      const { data: link, status } = await apiPostWithStatus<Link, { collection: CollectionKind; url: string; label?: string }>(`/api/projects/${projectId}/links`, { collection, url, label: label.trim() || undefined });
      if (status === 201) {
        setLinks((current) => [...current.filter((item) => item.id !== link.id), link]);
        setUrl(""); setLabel(""); await invalidateActivity(); await reportLinksChanged(); onToast("Link added.");
      } else {
        // Nothing was written server-side, so don't move the existing tile to the end of the
        // list the way a real append would — only fill it in if this client didn't have it yet.
        setLinks((current) => current.some((item) => item.id === link.id) ? current.map((item) => item.id === link.id ? link : item) : [...current, link]);
        onToast("This link is already in the list.", "error");
      }
    } catch (error) { terminateOnUnauthorized(error); onToast(error instanceof Error ? error.message : "The link could not be added.", "error"); }
    finally { setSavingLink(false); }
  }
  async function removeLink(link: Link) { try { await apiDelete<void>(`/api/projects/${projectId}/links/${link.id}`); setLinks((current) => current.filter((item) => item.id !== link.id)); await invalidateActivity(); onToast("Manual link removed."); await reportLinksChanged(); } catch (error) { terminateOnUnauthorized(error); onToast(error instanceof Error ? error.message : "The link could not be removed.", "error"); } }
  function startEdit(link: Link) { setEditingLinkId(link.id); setEditDraft({ url: link.url, label: link.label ?? "" }); setEditError(""); }
  function cancelEdit() { setEditingLinkId(null); setEditDraft({ url: "", label: "" }); setEditError(""); }
  async function saveEdit(event: FormEvent) {
    event.preventDefault(); if (!editingLinkId) return;
    if (!httpsUrl(editDraft.url)) { setEditError("Enter an HTTPS URL."); return; }
    setSavingEdit(true); setEditError("");
    try {
      const link = await apiPatch<Link, { url: string; label?: string }>(`/api/projects/${projectId}/links/${editingLinkId}`, { url: editDraft.url, label: editDraft.label.trim() || undefined });
      setLinks((current) => current.map((item) => item.id === link.id ? link : item)); cancelEdit(); await invalidateActivity(); onToast("Link updated.");
    } catch (error) { terminateOnUnauthorized(error); setEditError(error instanceof Error ? error.message : "The link could not be updated."); }
    finally { setSavingEdit(false); }
  }
  async function reorderLinks(event: DragEndEvent) {
    const activeId = String(event.active.id); const neighbors = reorderNeighbors(links.map((link) => link.id), activeId, event.over ? String(event.over.id) : null);
    if (!neighbors) return;
    setReorderingLinkId(activeId);
    try {
      await apiPost<{ position: number }, { beforeId: string | null; afterId: string | null }>(`/api/projects/${projectId}/links/${activeId}/reorder`, { beforeId: neighbors.beforeId, afterId: neighbors.afterId });
      await invalidateActivity(); await loadLinks();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try { await loadLinks(); } catch (reloadError) { terminateOnUnauthorized(reloadError); onToast(reloadError instanceof Error ? reloadError.message : "Delivered links could not be loaded.", "error"); }
        onToast("Link order changed; reload and try again", "error");
      } else { terminateOnUnauthorized(error); onToast(error instanceof Error ? error.message : "The link could not be reordered.", "error"); }
    } finally { setReorderingLinkId(null); }
  }
  async function deleteVersion(document: WorkspaceAsset) {
    if (!onDelete || !await confirm({ title: `Delete version ${document.version}?`, message: `Permanently delete version ${document.version}? This cannot be undone.`, confirmLabel: "Delete", danger: true })) return;
    try { await onDelete(document.id); }
    catch (error) { terminateOnUnauthorized(error); onToast(error instanceof Error ? error.message : "The asset could not be deleted.", "error"); }
  }
  function chooseUpload(groupId?: string) { setUploadGroupId(groupId); (collection === "floorplan" ? floorplanInput : copyInput).current?.click(); }
  async function uploadCopy(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; const versionGroupId = uploadGroupId; setUploadGroupId(undefined);
    if (!file) return; if (!isPdf(file)) { onToast("Copywriting uploads must be PDFs.", "error"); return; }
    let sessionId: string | undefined; setUploading(true); try {
      const presign = await apiPost<DocumentPresign, { kind: "copy_pdf"; versionGroupId?: string; pdf: { filename: string; bytes: number; contentType: string } }>(`/api/projects/${projectId}/documents/presign`, { kind: "copy_pdf", versionGroupId, pdf: { filename: file.name, bytes: file.size, contentType: file.type } });
      sessionId = presign.sessionId;
      const pdf = await uploadMultipartFile(file, presign.files.pdf, `/api/projects/${projectId}/documents/direct/${presign.sessionId}/pdf`);
      await apiPost(`/api/projects/${projectId}/documents/complete`, { sessionId: presign.sessionId, pdf }); await reportDocumentsChanged("copy"); onToast("Copywriting PDF uploaded.");
    } catch (error) { terminateOnUnauthorized(error); if (sessionId) void apiPost(`/api/projects/${projectId}/documents/${sessionId}/abort`, {}).catch((abortError) => terminateOnUnauthorized(abortError)); onToast(error instanceof Error ? error.message : "The document could not be uploaded.", "error"); } finally { setUploading(false); }
  }
  async function uploadFloorplan(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []); event.target.value = ""; const versionGroupId = uploadGroupId; setUploadGroupId(undefined);
    const pdfs = files.filter(isPdf), previews = files.filter(isJpeg);
    if (files.length !== 2 || pdfs.length !== 1 || previews.length !== 1) { onToast("Select exactly one PDF and one JPEG preview for each floorplan version.", "error"); return; }
    const [pdf] = pdfs; const [preview] = previews; let sessionId: string | undefined; setUploading(true); try {
      const presign = await apiPost<DocumentPresign, { kind: "floorplan"; versionGroupId?: string; pdf: { filename: string; bytes: number; contentType: string }; preview: { filename: string; bytes: number; contentType: string } }>(`/api/projects/${projectId}/documents/presign`, { kind: "floorplan", versionGroupId, pdf: { filename: pdf!.name, bytes: pdf!.size, contentType: pdf!.type }, preview: { filename: preview!.name, bytes: preview!.size, contentType: preview!.type } });
      sessionId = presign.sessionId;
      const [completedPdf, completedPreview] = await Promise.all([
        uploadMultipartFile(pdf!, presign.files.pdf, `/api/projects/${projectId}/documents/direct/${presign.sessionId}/pdf`),
        uploadMultipartFile(preview!, presign.files.preview!, `/api/projects/${projectId}/documents/direct/${presign.sessionId}/preview`),
      ]);
      await apiPost(`/api/projects/${projectId}/documents/complete`, { sessionId: presign.sessionId, pdf: completedPdf, preview: completedPreview }); await reportDocumentsChanged("floorplan"); onToast(`Floorplan v${presign.version} uploaded.`);
    } catch (error) { terminateOnUnauthorized(error); if (sessionId) void apiPost(`/api/projects/${projectId}/documents/${sessionId}/abort`, {}).catch((abortError) => terminateOnUnauthorized(abortError)); onToast(error instanceof Error ? error.message : "The floorplan could not be uploaded.", "error"); } finally { setUploading(false); }
  }

  if (collection === "video") return <div className="collection-panel"><div className="workspace-intro"><div><div className="ey">Video delivery</div><h1 className="serif">Video links</h1></div><div className="muted">External delivery links remain connected to the project, ready for the final hand-off.</div></div><div className="collection-content grid gap-[var(--space-5)] p-[var(--space-6)]"><LinkTiles video canReorder={canManage} reorderingLinkId={reorderingLinkId} onDragEnd={(event) => void reorderLinks(event)} links={links} onEdit={canManage ? startEdit : undefined} onRemove={canManage ? removeLink : undefined} editingLinkId={editingLinkId} editDraft={editDraft} editError={editError} savingEdit={savingEdit} onEditDraftChange={setEditDraft} onSaveEdit={(event) => void saveEdit(event)} onCancelEdit={cancelEdit} />{!links.length && <div className="empty"><span className="serif">No video link yet.</span>{canManage ? "Add the first delivery link below." : "Delivered video will appear here."}</div>}{canManage && <form className={cn(LINK_FORM_BASE, "p-[var(--space-4)] bg-secondary border-solid border-[length:var(--border-width-hair)] border-border", "min-[640px]:grid-cols-[minmax(220px,1.5fr)_minmax(180px,1fr)_auto]")} data-testid="collection-link-add" onSubmit={(event) => void addLink(event)}><label className={LINK_FORM_LABEL}><span>Link URL</span><input className={RAIL_FIELD} required type="url" placeholder="https://vimeo.com/…" value={url} onChange={(event) => setUrl(event.target.value)} /></label><label className={LINK_FORM_LABEL}><span>Label <em className="not-italic text-foreground-secondary">optional</em></span><input className={RAIL_FIELD} placeholder="Final walkthrough" value={label} onChange={(event) => setLabel(event.target.value)} /></label><button className={buttonClasses("primary", { className: "min-h-[44px] self-end" })} disabled={savingLink}>{savingLink ? "Adding…" : "Add link"}</button></form>}</div></div>;

  const pdfKind = collection === "floorplan" ? "floorplan_pdf" : "copy_pdf";
  const groups = [...new Set(assets.filter((asset) => asset.kind === pdfKind).map((asset) => asset.versionGroupId ?? asset.id))].map((groupId) => {
    const newestFirst = (a: WorkspaceAsset, b: WorkspaceAsset) => b.version - a.version || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
    const documents = assets.filter((asset) => asset.kind === pdfKind && (asset.versionGroupId ?? asset.id) === groupId).sort(newestFirst); const latest = documents[0]!;
    const preview = collection === "floorplan" ? assets.find((asset) => asset.kind === "floorplan_preview" && asset.versionGroupId === groupId && asset.version === latest.version) ?? null : null;
    return { groupId, documents, latest, preview, isLegacyIncomplete: collection === "floorplan" && !preview };
  });
  const title = collection === "floorplan" ? "Floorplans" : "Copywriting";
  return <div className="collection-panel"><div className="workspace-intro"><div><div className="ey">{collection === "floorplan" ? "Floorplan delivery" : "Copy delivery"}</div><h1 className="serif">{title}</h1></div><div className="row gap2">{canManage && <button className={buttonClasses()} type="button" disabled={uploading} onClick={() => chooseUpload()}>{uploading ? "Uploading…" : `Upload ${collection === "floorplan" ? "floorplan" : "copy"}`}</button>}</div></div><div className="collection-content grid gap-[var(--space-5)] p-[var(--space-6)]">{links.length > 0 && <section className="collection-delivered grid gap-[var(--space-3)]"><div className="ey">Delivered links</div><LinkTiles links={links} /></section>}{groups.map(({ groupId, documents, latest, preview, isLegacyIncomplete }) => <section className={`document-group ${latest.review?.decision === "approved" ? "is-approved" : ""}`} data-testid="document-group" key={groupId}>{preview ? <DocumentPreview preview={preview} latest={latest} /> : isLegacyIncomplete ? <div className="document-preview document-preview--incomplete" role="status">Preview unavailable for this legacy version.</div> : null}<div className="document-group__body"><div className="document-group__head"><div><div className="ey">Version group</div><a className="document-title serif" href={assetUrl(latest)} target="_blank" rel="noreferrer">{latest.originalFilename}</a><div className="muted">v{latest.version} · {formatDate(latest.createdAt)}</div></div><div className="row gap2">{latest.review?.decision === "approved" && <span className="statetag st-approved">Approved · default deliverable</span>}{canApprove && <button className={buttonClasses(latest.review?.decision === "approved" ? "secondary" : "primary")} type="button" onClick={() => void onReview(latest.id, { decision: latest.review?.decision === "approved" ? null : "approved" })}>{latest.review?.decision === "approved" ? "Unapprove" : "Approve"}</button>}</div></div><div className="document-history"><span className="ey">Version history</span>{documents.map((document) => <div className="document-history__entry" key={document.id}><a href={assetUrl(document)} target="_blank" rel="noreferrer">v{document.version}<small>{formatDate(document.createdAt)}</small></a>{canDelete && onDelete && <button className="chip" type="button" data-testid="document-version-delete" onClick={() => void deleteVersion(document)}>Delete</button>}</div>)}</div>{canManage && <div className="document-actions"><button className="chip" type="button" data-testid="document-upload-version" disabled={uploading} onClick={() => chooseUpload(groupId)}>Upload new version</button></div>}</div></section>)}{groups.length === 0 && <div className="empty"><span className="serif">No {collection === "floorplan" ? "floorplan" : "copy PDF"} yet.</span>{canManage ? collection === "floorplan" ? "Upload a PDF and JPEG preview together to begin immutable floorplan versions." : "Upload the first version to begin its immutable history." : "Delivered documents will appear here."}</div>}</div><input ref={copyInput} className="sr-only" type="file" accept="application/pdf" onChange={(event) => void uploadCopy(event)} /><input ref={floorplanInput} className="sr-only" type="file" accept="application/pdf,image/jpeg" multiple onChange={(event) => void uploadFloorplan(event)} /></div>;
}
