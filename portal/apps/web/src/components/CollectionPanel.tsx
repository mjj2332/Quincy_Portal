import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { WorkspaceAsset } from "./PhotoGrid";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPostWithStatus } from "../lib/api";
import { uploadMultipartFile, type MultipartPresign } from "../lib/multipart-upload";
import { useProjectAccessTermination } from "../lib/project-data";
import { LazyImage } from "./LazyImage";
import { reorderNeighbors } from "../lib/reorder-neighbors";
import { confirm } from "../lib/confirm";

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
  const safeUrl = httpsUrl(link.url); const title = link.label || hostLabel(link.url); const content = <><span className="collection-link__name">{title}</span><span className="chip">{hostLabel(link.url)}</span></>;
  const isEditing = editingLinkId === link.id;
  const errorId = `collection-link-edit-error-${link.id}`;
  const dragProps = { ...attributes, ...listeners, ...(busy ? { "aria-disabled": true } : {}) };
  return <div ref={sortable ? setNodeRef : undefined} style={sortable ? { transform: CSS.Transform.toString(transform), transition } : undefined} className={`collection-link${isDragging ? " collection-link--dragging" : ""}`}>{isEditing && editDraft && onEditDraftChange && onSaveEdit && onCancelEdit ? <form className="collection-link-form collection-link-editor" onSubmit={onSaveEdit}><label><span>Label <em>optional</em></span><input aria-describedby={editError ? errorId : undefined} placeholder="Final walkthrough" value={editDraft.label} onChange={(event) => onEditDraftChange({ ...editDraft, label: event.target.value })} /></label><label><span>Link URL</span><input required type="url" aria-describedby={editError ? errorId : undefined} placeholder="https://vimeo.com/…" value={editDraft.url} onChange={(event) => onEditDraftChange({ ...editDraft, url: event.target.value })} /></label>{editError && <p id={errorId} className="collection-link-editor__error" role="alert">{editError}</p>}<div className="collection-link-editor__actions"><button className="button" disabled={savingEdit}>{savingEdit ? "Saving…" : "Save"}</button><button className="button button--secondary" type="button" disabled={savingEdit} onClick={onCancelEdit}>Cancel</button></div></form> : <>{safeUrl ? <a href={safeUrl.href} target="_blank" rel="noopener noreferrer">{content}</a> : <div className="collection-link__plain">{content}</div>}<div className="collection-link__meta">{sortable && <button ref={setActivatorNodeRef} type="button" className="collection-link__grip" aria-label={`Reorder ${title}`} {...dragProps}>⠿</button>}<span className={`statetag ${link.source === "tonomo" ? "st-editing" : ""}`}>{link.source === "tonomo" ? "Tonomo" : "Manual"}</span>{onEdit && link.source === "manual" && <button type="button" className="button button--text" onClick={() => onEdit(link)}>Edit</button>}{onRemove && link.source === "manual" && <button type="button" className="button button--text" onClick={() => onRemove(link)}>Remove</button>}</div></>}</div>;
}

function LinkTiles({ links, video = false, canReorder = false, reorderingLinkId, onDragEnd, onRemove, onEdit, editingLinkId, editDraft, editError, savingEdit, onEditDraftChange, onSaveEdit, onCancelEdit }: {
  links: Link[]; onRemove?: (link: Link) => void; onEdit?: (link: Link) => void; editingLinkId?: string | null;
  video?: boolean; canReorder?: boolean; reorderingLinkId?: string | null; onDragEnd?: (event: DragEndEvent) => void;
  editDraft?: { url: string; label: string }; editError?: string; savingEdit?: boolean;
  onEditDraftChange?: (draft: { url: string; label: string }) => void; onSaveEdit?: (event: FormEvent) => void; onCancelEdit?: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  if (!links.length) return null;
  const grid = <div className={`collection-links${video ? " collection-links--video" : ""}`}>{links.map((link) => <LinkTile key={link.id} link={link} sortable={canReorder && editingLinkId !== link.id} busy={Boolean(reorderingLinkId) || Boolean(editingLinkId)} onEdit={onEdit} onRemove={onRemove} editingLinkId={editingLinkId} editDraft={editDraft} editError={editError} savingEdit={savingEdit} onEditDraftChange={onEditDraftChange} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} />)}</div>;
  if (!canReorder || !onDragEnd) return grid;
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}><SortableContext items={links.map((link) => link.id)} strategy={rectSortingStrategy}>{grid}</SortableContext></DndContext>;
}

export function CollectionPanel({ projectId, collection, assets, canManage, canDelete = false, canApprove, onReview, onDelete, onChanged, onLinksChanged, onDocumentsChanged, onToast }: {
  projectId: string; collection: CollectionKind; assets: WorkspaceAsset[]; canManage: boolean; canDelete?: boolean; canApprove: boolean;
  onReview: (assetId: string, patch: { decision: "approved" | null }) => Promise<void>; onDelete?: (assetId: string) => Promise<void>; onChanged?: () => Promise<void>; onLinksChanged?: () => Promise<void>; onDocumentsChanged?: (kind: "floorplan" | "copy") => Promise<void>; onToast: (message: string, tone?: "success" | "error") => void;
}) {
  const terminateOnUnauthorized = useProjectAccessTermination();
  const reportLinksChanged = onLinksChanged ?? onChanged ?? (async () => undefined);
  const reportDocumentsChanged = onDocumentsChanged ?? (async () => onChanged?.());
  const [links, setLinks] = useState<Link[]>([]); const [url, setUrl] = useState(""); const [label, setLabel] = useState(""); const [savingLink, setSavingLink] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null); const [editDraft, setEditDraft] = useState({ url: "", label: "" }); const [editError, setEditError] = useState(""); const [savingEdit, setSavingEdit] = useState(false); const [reorderingLinkId, setReorderingLinkId] = useState<string | null>(null);
  const [uploadGroupId, setUploadGroupId] = useState<string | undefined>(); const [uploading, setUploading] = useState(false); const copyInput = useRef<HTMLInputElement>(null); const floorplanInput = useRef<HTMLInputElement>(null);
  const loadToken = useRef(0);
  const loadLinks = useCallback(async () => {
    const token = ++loadToken.current;
    const response = await apiGet<{ links: Link[] }>(`/api/projects/${projectId}/links?collection=${collection}`);
    // A stale response (e.g. the collection tab changed, or an overlapping reorder reload)
    // must not clobber a newer load's result.
    if (loadToken.current === token) setLinks(response.links);
  }, [collection, projectId]);
  useEffect(() => { let active = true; void loadLinks().catch((error: unknown) => { terminateOnUnauthorized(error); if (active) onToast(error instanceof Error ? error.message : "Delivered links could not be loaded.", "error"); }); return () => { active = false; }; }, [loadLinks, onToast, terminateOnUnauthorized]);
  async function addLink(event: FormEvent) {
    event.preventDefault(); setSavingLink(true);
    try {
      const { data: link, status } = await apiPostWithStatus<Link, { collection: CollectionKind; url: string; label?: string }>(`/api/projects/${projectId}/links`, { collection, url, label: label.trim() || undefined });
      if (status === 201) {
        setLinks((current) => [...current.filter((item) => item.id !== link.id), link]);
        setUrl(""); setLabel(""); await reportLinksChanged(); onToast("Link added.");
      } else {
        // Nothing was written server-side, so don't move the existing tile to the end of the
        // list the way a real append would — only fill it in if this client didn't have it yet.
        setLinks((current) => current.some((item) => item.id === link.id) ? current.map((item) => item.id === link.id ? link : item) : [...current, link]);
        onToast("This link is already in the list.", "error");
      }
    } catch (error) { terminateOnUnauthorized(error); onToast(error instanceof Error ? error.message : "The link could not be added.", "error"); }
    finally { setSavingLink(false); }
  }
  async function removeLink(link: Link) { try { await apiDelete<void>(`/api/projects/${projectId}/links/${link.id}`); setLinks((current) => current.filter((item) => item.id !== link.id)); onToast("Manual link removed."); await reportLinksChanged(); } catch (error) { terminateOnUnauthorized(error); onToast(error instanceof Error ? error.message : "The link could not be removed.", "error"); } }
  function startEdit(link: Link) { setEditingLinkId(link.id); setEditDraft({ url: link.url, label: link.label ?? "" }); setEditError(""); }
  function cancelEdit() { setEditingLinkId(null); setEditDraft({ url: "", label: "" }); setEditError(""); }
  async function saveEdit(event: FormEvent) {
    event.preventDefault(); if (!editingLinkId) return;
    if (!httpsUrl(editDraft.url)) { setEditError("Enter an HTTPS URL."); return; }
    setSavingEdit(true); setEditError("");
    try {
      const link = await apiPatch<Link, { url: string; label?: string }>(`/api/projects/${projectId}/links/${editingLinkId}`, { url: editDraft.url, label: editDraft.label.trim() || undefined });
      setLinks((current) => current.map((item) => item.id === link.id ? link : item)); cancelEdit(); onToast("Link updated.");
    } catch (error) { terminateOnUnauthorized(error); setEditError(error instanceof Error ? error.message : "The link could not be updated."); }
    finally { setSavingEdit(false); }
  }
  async function reorderLinks(event: DragEndEvent) {
    const activeId = String(event.active.id); const neighbors = reorderNeighbors(links.map((link) => link.id), activeId, event.over ? String(event.over.id) : null);
    if (!neighbors) return;
    setReorderingLinkId(activeId);
    try {
      await apiPost<{ position: number }, { beforeId: string | null; afterId: string | null }>(`/api/projects/${projectId}/links/${activeId}/reorder`, { beforeId: neighbors.beforeId, afterId: neighbors.afterId });
      await loadLinks();
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

  if (collection === "video") return <div className="collection-panel"><div className="workspace-intro"><div><div className="ey">Video delivery</div><h1 className="serif">Video links</h1></div><div className="muted">External delivery links remain connected to the project, ready for the final hand-off.</div></div><div className="collection-content"><LinkTiles video canReorder={canManage} reorderingLinkId={reorderingLinkId} onDragEnd={(event) => void reorderLinks(event)} links={links} onEdit={canManage ? startEdit : undefined} onRemove={canManage ? removeLink : undefined} editingLinkId={editingLinkId} editDraft={editDraft} editError={editError} savingEdit={savingEdit} onEditDraftChange={setEditDraft} onSaveEdit={(event) => void saveEdit(event)} onCancelEdit={cancelEdit} />{!links.length && <div className="empty"><span className="serif">No video link yet.</span>{canManage ? "Add the first delivery link below." : "Delivered video will appear here."}</div>}{canManage && <form className="collection-link-form" onSubmit={(event) => void addLink(event)}><label><span>Link URL</span><input required type="url" placeholder="https://vimeo.com/…" value={url} onChange={(event) => setUrl(event.target.value)} /></label><label><span>Label <em>optional</em></span><input placeholder="Final walkthrough" value={label} onChange={(event) => setLabel(event.target.value)} /></label><button className="button" disabled={savingLink}>{savingLink ? "Adding…" : "Add link"}</button></form>}</div></div>;

  const pdfKind = collection === "floorplan" ? "floorplan_pdf" : "copy_pdf";
  const groups = [...new Set(assets.filter((asset) => asset.kind === pdfKind).map((asset) => asset.versionGroupId ?? asset.id))].map((groupId) => {
    const newestFirst = (a: WorkspaceAsset, b: WorkspaceAsset) => b.version - a.version || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
    const documents = assets.filter((asset) => asset.kind === pdfKind && (asset.versionGroupId ?? asset.id) === groupId).sort(newestFirst); const latest = documents[0]!;
    const preview = collection === "floorplan" ? assets.find((asset) => asset.kind === "floorplan_preview" && asset.versionGroupId === groupId && asset.version === latest.version) ?? null : null;
    return { groupId, documents, latest, preview, isLegacyIncomplete: collection === "floorplan" && !preview };
  });
  const title = collection === "floorplan" ? "Floorplans" : "Copywriting";
  return <div className="collection-panel"><div className="workspace-intro"><div><div className="ey">{collection === "floorplan" ? "Floorplan delivery" : "Copy delivery"}</div><h1 className="serif">{title}</h1></div><div className="row gap2">{canManage && <button className="button" type="button" disabled={uploading} onClick={() => chooseUpload()}>{uploading ? "Uploading…" : `Upload ${collection === "floorplan" ? "floorplan" : "copy"}`}</button>}</div></div><div className="collection-content">{links.length > 0 && <section className="collection-delivered"><div className="ey">Delivered links</div><LinkTiles links={links} /></section>}{groups.map(({ groupId, documents, latest, preview, isLegacyIncomplete }) => <section className={`document-group ${latest.review?.decision === "approved" ? "is-approved" : ""}`} key={groupId}>{preview ? <DocumentPreview preview={preview} latest={latest} /> : isLegacyIncomplete ? <div className="document-preview document-preview--incomplete" role="status">Preview unavailable for this legacy version.</div> : null}<div className="document-group__body"><div className="document-group__head"><div><div className="ey">Version group</div><a className="document-title serif" href={assetUrl(latest)} target="_blank" rel="noreferrer">{latest.originalFilename}</a><div className="muted">v{latest.version} · {formatDate(latest.createdAt)}</div></div><div className="row gap2">{latest.review?.decision === "approved" && <span className="statetag st-approved">Approved · default deliverable</span>}{canApprove && <button className={`button ${latest.review?.decision === "approved" ? "button--secondary" : ""}`} type="button" onClick={() => void onReview(latest.id, { decision: latest.review?.decision === "approved" ? null : "approved" })}>{latest.review?.decision === "approved" ? "Unapprove" : "Approve"}</button>}</div></div><div className="document-history"><span className="ey">Version history</span>{documents.map((document) => <div className="document-history__entry" key={document.id}><a href={assetUrl(document)} target="_blank" rel="noreferrer">v{document.version}<small>{formatDate(document.createdAt)}</small></a>{canDelete && onDelete && <button className="chip" type="button" onClick={() => void deleteVersion(document)}>Delete</button>}</div>)}</div>{canManage && <div className="document-actions"><button className="chip" type="button" disabled={uploading} onClick={() => chooseUpload(groupId)}>Upload new version</button></div>}</div></section>)}{groups.length === 0 && <div className="empty"><span className="serif">No {collection === "floorplan" ? "floorplan" : "copy PDF"} yet.</span>{canManage ? collection === "floorplan" ? "Upload a PDF and JPEG preview together to begin immutable floorplan versions." : "Upload the first version to begin its immutable history." : "Delivered documents will appear here."}</div>}</div><input ref={copyInput} className="sr-only" type="file" accept="application/pdf" onChange={(event) => void uploadCopy(event)} /><input ref={floorplanInput} className="sr-only" type="file" accept="application/pdf,image/jpeg" multiple onChange={(event) => void uploadFloorplan(event)} /></div>;
}
