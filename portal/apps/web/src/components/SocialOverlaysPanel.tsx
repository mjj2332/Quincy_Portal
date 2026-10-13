import { useCallback, useEffect, useRef, useState } from "react";
import { SOCIAL_OVERLAY_NAME_MAX, SOCIAL_OVERLAY_PLATFORM_MAX, type SocialOverlayDto } from "@quincy/shared";
import { Modal } from "./Modal";
import { Button } from "@/components/reui/button";
import { Switch } from "@/components/reui/switch";
import { EmptyState } from "@/components/quincy/EmptyState";
import { FilePickButton } from "@/components/quincy/FileDropzone";
import { Notice } from "@/components/quincy/Notice";
import { QuincyField } from "@/components/quincy/QuincyField";
import { SectionHead } from "@/components/quincy/SectionHead";
import { StatusPill } from "@/components/quincy/StatusPill";
import { TableActions, TableWrap, Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from "@/components/quincy/Table";
import { confirm } from "../lib/confirm";
import { pushToast } from "../lib/toast-store";
import {
  checkOverlayFile, createSocialOverlay, listSocialOverlays, overlayErrorMessage, renameSocialOverlay, replaceSocialOverlayImage, setSocialOverlayArchived,
} from "../lib/social-overlays";

type DialogKind = { kind: "create" } | { kind: "rename"; overlay: SocialOverlayDto } | { kind: "replace"; overlay: SocialOverlayDto };
/** Each opened dialog carries its own id, so a save that outlives its dialog can be told apart from the dialog now on screen. */
type Dialog = DialogKind & { id: number };
const HINT = "PNG · 9:16 · transparent · max 8 MB. Export it with an alpha channel; a fully opaque image is not detected.";
const TEXT_BUTTON = "min-h-[32px] px-0 py-[6px]";
const TOGGLE_ROW = "flex items-center gap-[var(--space-2)] cursor-pointer min-h-[38px] max-[721px]:min-h-[44px] text-foreground-secondary";
// A checkerboard so the transparent parts of an overlay read as transparent, built from tokens.
const CHECKER = "bg-surface-sunken [background-image:repeating-conic-gradient(var(--surface-sunken)_0%_25%,var(--background)_0%_50%)] [background-size:var(--space-3)_var(--space-3)]";

const formatBytes = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const formatDate = (value: number): string => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));

/**
 * Admin > Social overlays (#869): the library of 9:16 platform graphics the Video viewer lays over a Video. The first overlay uploaded becomes the Default. The server validates every
 * PNG; the pre-check here only gives instant copy. Mutations carry the overlay's `revision`, so a stale list gets a plain conflict message instead of overwriting someone else.
 */
export function SocialOverlaysPanel() {
  const [overlays, setOverlays] = useState<SocialOverlayDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const currentDialog = useRef<number | null>(null);
  const nextDialog = useRef(0);
  const open = (kind: DialogKind) => { const id = ++nextDialog.current; currentDialog.current = id; setDialog({ ...kind, id }); };
  const close = () => { currentDialog.current = null; setDialog(null); };

  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { setOverlays(await listSocialOverlays()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Social overlays could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const replaceRow = (next: SocialOverlayDto) => setOverlays((current) => current.some((row) => row.id === next.id) ? current.map((row) => row.id === next.id ? next : row) : [...current, next]);
  const visible = overlays.filter((overlay) => showArchived || overlay.archivedAt === null);

  async function toggleArchive(overlay: SocialOverlayDto) {
    const archiving = overlay.archivedAt === null;
    if (archiving && !await confirm({ title: `Archive ${overlay.name}?`, message: "It is hidden from new Social previews. Its image stays readable, and you can unarchive it.", confirmLabel: "Archive", danger: true })) return;
    setBusy(true);
    try { replaceRow(await setSocialOverlayArchived(overlay, archiving)); pushToast(archiving ? "Overlay archived." : "Overlay restored.", "success"); }
    catch (reason) { pushToast(overlayErrorMessage(reason), "error"); }
    finally { setBusy(false); }
  }

  return <>
    <SectionHead eyebrow="Video review" actions={<>
      <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>Refresh</Button>
      <Button type="button" onClick={() => open({ kind: "create" })}>Upload overlay</Button>
    </>}>Social overlays</SectionHead>
    <p className="m-0 mb-[var(--space-4)] max-w-[60ch] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">
      Platform graphics a reviewer can lay over a Video to see it as it would look in Instagram, TikTok or YouTube Shorts.
    </p>
    <label className={`${TOGGLE_ROW} mb-[var(--space-4)] w-fit`}><Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label="Show archived" /><span>Show archived</span></label>
    {error && <Notice role="alert" className="mb-[var(--space-4)]">{error}</Notice>}
    {loading && overlays.length === 0 && !error && <EmptyState role="status" title="Loading overlays.">Reading the Social overlay library.</EmptyState>}
    {!loading && !error && overlays.length === 0 && <EmptyState title="No Social overlays yet.">The first overlay you upload becomes the Default. Start with Instagram Reel.</EmptyState>}
    {visible.length > 0 && <TableWrap><Table>
      <TableHead><TableRow><TableHeader>Preview</TableHeader><TableHeader>Name</TableHeader><TableHeader>Platform</TableHeader><TableHeader>Image</TableHeader><TableHeader>Updated</TableHeader><TableHeader><span className="sr-only">Actions</span></TableHeader></TableRow></TableHead>
      <TableBody>{visible.map((overlay) => <TableRow key={overlay.id} data-testid="social-overlay-row">
        <TableCell data-label="Preview"><div className={`aspect-[9/16] w-[calc(var(--space-8)*1.25)] overflow-hidden border-solid border-[length:var(--border-width-hair)] border-border ${CHECKER}`}>
          <img src={overlay.imageUrl} alt={`${overlay.name} overlay preview`} className="block size-full object-contain" loading="lazy" />
        </div></TableCell>
        <TableCell data-label="Name"><div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <span>{overlay.name}</span>
          {overlay.isDefault && <StatusPill tone="positive">Default</StatusPill>}
          {overlay.archivedAt !== null && <StatusPill tone="neutral">Archived</StatusPill>}
        </div></TableCell>
        <TableCell data-label="Platform">{overlay.platformLabel}</TableCell>
        <TableCell data-label="Image">{overlay.width} × {overlay.height} · {formatBytes(overlay.bytes)}</TableCell>
        <TableCell data-label="Updated">{formatDate(overlay.updatedAt)} · {overlay.updatedBy.name}</TableCell>
        <TableCell><TableActions>
          <Button type="button" variant="ghost" className={TEXT_BUTTON} aria-label={`Rename ${overlay.name}`} onClick={() => open({ kind: "rename", overlay })}>Rename</Button>
          <Button type="button" variant="ghost" className={TEXT_BUTTON} aria-label={`Replace image for ${overlay.name}`} onClick={() => open({ kind: "replace", overlay })}>Replace image</Button>
          {!overlay.isDefault && <Button type="button" variant="ghost" className={TEXT_BUTTON} disabled={busy} aria-label={`${overlay.archivedAt === null ? "Archive" : "Unarchive"} ${overlay.name}`} onClick={() => void toggleArchive(overlay)}>{overlay.archivedAt === null ? "Archive" : "Unarchive"}</Button>}
        </TableActions></TableCell>
      </TableRow>)}</TableBody>
    </Table></TableWrap>}
    {dialog && <OverlayDialog key={dialog.id} dialog={dialog} onClose={close} onSaved={(next, saved) => {
      // The saved row is real whichever dialog started it. Only the dialog still on screen may be closed by it.
      replaceRow(next);
      if (currentDialog.current === saved.id) close();
      pushToast(saved.kind === "create" ? "Overlay uploaded." : "Overlay updated.", "success");
    }} />}
  </>;
}

function OverlayDialog({ dialog, onClose, onSaved }: { dialog: Dialog; onClose: () => void; onSaved: (overlay: SocialOverlayDto, saved: Dialog) => void }) {
  const existing = dialog.kind === "create" ? null : dialog.overlay;
  const [name, setName] = useState(existing?.name ?? "");
  const [platformLabel, setPlatformLabel] = useState(existing?.platformLabel ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const needsFile = dialog.kind !== "rename", needsFields = dialog.kind !== "replace";
  const submitLabel = dialog.kind === "create" ? "Upload" : dialog.kind === "rename" ? "Save" : "Replace";
  const title = dialog.kind === "create" ? "Upload a Social overlay" : dialog.kind === "rename" ? `Rename ${dialog.overlay.name}` : `Replace image for ${dialog.overlay.name}`;
  const valid = (!needsFields || (name.trim().length > 0 && platformLabel.trim().length > 0)) && (!needsFile || (file !== null && !fileError));

  async function choose(picked: File) {
    setSaveError(undefined);
    const problem = await checkOverlayFile(picked);
    setFile(problem ? null : picked); setFileError(problem ?? undefined);
  }
  async function submit() {
    if (!valid || saving) return;
    setSaving(true); setSaveError(undefined);
    try {
      if (dialog.kind === "create") onSaved(await createSocialOverlay({ name: name.trim(), platformLabel: platformLabel.trim(), file: file! }), dialog);
      else if (dialog.kind === "rename") onSaved(await renameSocialOverlay(dialog.overlay, { name: name.trim(), platformLabel: platformLabel.trim() }), dialog);
      else onSaved(await replaceSocialOverlayImage(dialog.overlay, file!), dialog);
    } catch (reason) { setSaveError(overlayErrorMessage(reason)); setSaving(false); }
  }

  return <Modal open title={title} eyebrow="Social overlay" testId="social-overlay-dialog" onClose={onClose}
    footer={<>
      <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      <Button type="button" disabled={!valid || saving} onClick={() => void submit()}>{submitLabel}</Button>
    </>}>
    <div className="flex flex-col gap-[var(--space-4)]">
      {needsFields && <>
        <QuincyField id="social-overlay-name" label="Name" value={name} maxLength={SOCIAL_OVERLAY_NAME_MAX} onChange={(event) => setName(event.target.value)} />
        <QuincyField id="social-overlay-platform" label="Platform" value={platformLabel} maxLength={SOCIAL_OVERLAY_PLATFORM_MAX} onChange={(event) => setPlatformLabel(event.target.value)} />
      </>}
      {needsFile && <div className="flex flex-col gap-[var(--space-2)]">
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          <FilePickButton accept="image/png" variant="secondary" onFile={(picked) => void choose(picked)}>{file ? "Choose another PNG" : "Choose PNG"}</FilePickButton>
          {file && <span className="[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">{file.name} · {formatBytes(file.size)}</span>}
        </div>
        <p className="m-0 [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">{HINT}</p>
        {fileError && <Notice role="alert">{fileError}</Notice>}
      </div>}
      {saveError && <Notice role="alert">{saveError}</Notice>}
    </div>
  </Modal>;
}
