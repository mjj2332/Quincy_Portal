import { useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { videoVersionDownloadUrl, type VideoDto } from "@quincy/shared";
import { Button } from "../quincy/Button";
import { Spinner } from "../reui/spinner";
import { Notice } from "../quincy/Notice";
import { useFilePick } from "../quincy/FileDropzone";
import type { VideoUploadState } from "../../lib/video-upload";
import { IconButton } from "../quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive, PANEL } from "../quincy/menu";
import { cn } from "@/lib/utils";
import type { ReviewLinkChip } from "./use-review-links-ui";

/**
 * The pieces a staff Video's tile (`VideoCard`) and its Video row (`VideoCollectionRows`, #939) both draw, moved out of VideoCard unchanged so the two cannot drift: the "⋯"
 * menu with its file picker, and the upload line under the title. The refusal and "Checking…" state they share lives in the panel's `createVersionFileState` store (S12).
 */

export const VIDEO_ACCEPT = ".mp4,.mov,video/mp4,video/quicktime";

const META = "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";
const SEPARATOR = "my-[var(--space-1)] h-px bg-border";

/** What the panel grants on one Video, alike for its tile and its row: the menu's optional items, the tick and the Review links submenu. */
export type VideoActions = {
  /** Present when staff may download (the `download` part and the capability): "⋯" then offers the current Version as an attachment (#866). */
  download?: { projectId: string };
  /** Present only when new Review links may be made (#834): the Review links submenu then offers Create Review link for this film. Absent on an archived Project. */
  onCreateReviewLink?: () => void;
  /** Present when the person may rename (#867: whoever may upload, on an unarchived Project). The dialog is hosted by the panel, above the filtered list. */
  onRename?: (video: VideoDto) => void;
  /** Present when staff may delete (the `trash` part and the capability, #868): "⋯" then ends with Delete…, in its own group. `disabled` on an archived Project. */
  remove?: { disabled: boolean; onOpen: () => void };
  /** The tick: present when the person may create a link or download. */
  select?: { selected: boolean; onToggle: () => void };
  /** The links part is on and the role may share: the Review links submenu and the link mark. */
  reviewLinks?: { chips: ReviewLinkChip[]; onOpenChip: (linkId: string) => void; onOpenAll: () => void };
};

/** Whether the film is on an active Review link (the tile's and row's link mark). */
export const hasActiveLink = (actions: VideoActions): boolean => (actions.reviewLinks?.chips ?? []).some((chip) => chip.status === "active");

/** The upload the server or this tab holds for the film: mine in this tab, someone's elsewhere, and whether that one is mine to cancel. */
export function videoUploadFacts(video: VideoDto, myUpload: VideoUploadState | undefined, currentUserId: string | null) {
  // The server says an upload is in flight and this tab has no job for it: someone else's, or mine that this tab lost (a reload, another device). Only its owner may cancel it.
  const elsewhere = !myUpload && video.uploading ? video.uploading : null;
  const cancellable = elsewhere && currentUserId !== null && elsewhere.uploader.id === currentUserId ? elsewhere : null;
  return { elsewhere, cancellable, busy: Boolean(myUpload || video.uploading) };
}

function Submenu({ label, testId, trigger, children }: { label: string; testId: string; trigger: ReactNode; children: ReactNode }) {
  return <MenuPrimitive.SubmenuRoot>
    <MenuPrimitive.SubmenuTrigger className={cn(MENU_ITEM, "justify-between gap-[var(--space-2)]")} data-testid={testId}>{trigger}<ChevronRight aria-hidden="true" className="size-4 shrink-0" /></MenuPrimitive.SubmenuTrigger>
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side="right" align="start" sideOffset={2} collisionPadding={8} className="z-[var(--z-popover)] outline-none">
        <MenuPrimitive.Popup className={PANEL} aria-label={label}>{children}</MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  </MenuPrimitive.SubmenuRoot>;
}

/**
 * A Video's "⋯" (#884, D23) and the hidden file input behind its Upload new Version item. The trigger carries `data-video-id`: the panel's dialogs return focus to it by that.
 * `onFile` is called with the picked file; `checking` shows while the last one is checked.
 */
export function VideoCardMenu({ video, newestVersion, canUploadNow, checking, onFile, onOpen, actions }: {
  video: VideoDto;
  newestVersion: number;
  canUploadNow: boolean;
  checking: boolean;
  onFile: (file: File) => void;
  /** Opens the review on `version`; `trigger` (the "⋯" itself) is where focus returns on close. */
  onOpen: (video: VideoDto, trigger: HTMLElement, version: number) => void;
  actions: VideoActions;
}) {
  const { download, onRename, remove, reviewLinks, onCreateReviewLink } = actions;
  // The menu closes before a dialog has focus: while an item hands off, the menu moves no focus (#463); the dialog returns focus to the "⋯" button itself.
  const handOff = useRef(false);
  // The viewer's focus-return target (#866): the "⋯" button itself, never a menu item, which is portalled and gone once the menu closes.
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const pick = useFilePick({ accept: VIDEO_ACCEPT, onFile });
  const activeLinks = reviewLinks?.chips.filter((chip) => chip.status === "active") ?? [];
  const openAt = (version: number) => { handOff.current = true; onOpen(video, menuTrigger.current ?? document.body, version); };
  return <>
    <Menu
      triggerLabel="Film actions" label="Film menu" triggerTestId="video-card-menu"
      triggerRender={<IconButton ref={menuTrigger} data-video-id={video.id} />}
      triggerClassName="text-foreground"
      trigger={<span aria-hidden="true">⋯</span>}
      finalFocus={() => (handOff.current ? false : undefined)}
      onOpenChange={(isOpen) => { if (isOpen) handOff.current = false; }}
    >
      {/* D23, in order: Upload new Version, Rename, Download, Versions, Review links ‖ Delete. Copy link and Social preview stay in the viewer (D5). */}
      {canUploadNow && <MenuPrimitive.Item className={MENU_ITEM} disabled={checking} data-testid="video-card-upload-version" onClick={pick.open}>{checking ? "Checking…" : "Upload new Version…"}</MenuPrimitive.Item>}
      {onRename && <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-card-rename" onClick={() => { handOff.current = true; onRename(video); }}>Rename…</MenuPrimitive.Item>}
      {download && <MenuPrimitive.LinkItem closeOnClick className={MENU_ITEM} data-testid="video-card-download" href={videoVersionDownloadUrl(download.projectId, video.currentAssetId)} download>{`Download v${newestVersion}`}</MenuPrimitive.LinkItem>}
      <Submenu label={`Versions of ${video.title}`} testId="video-card-versions" trigger={`Versions (${video.versions.length})`}>
        {video.versions.map((version) => <MenuPrimitive.Item key={version.assetId} className={MENU_ITEM} data-testid={`video-card-version-${version.version}`} onClick={() => { openAt(version.version); }}>{`v${version.version}`}</MenuPrimitive.Item>)}
      </Submenu>
      {reviewLinks && <Submenu label={`Review links for ${video.title}`} testId="video-card-links" trigger="Review links">
        {activeLinks.map((chip) => <MenuPrimitive.Item key={chip.id} className={MENU_ITEM} data-testid="video-card-link-chip" onClick={() => { handOff.current = true; reviewLinks.onOpenChip(chip.id); }}>{chip.label ?? "Untitled link"}</MenuPrimitive.Item>)}
        <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-card-links-all" onClick={() => { handOff.current = true; reviewLinks.onOpenAll(); }}>All Review links</MenuPrimitive.Item>
        {onCreateReviewLink && <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-card-create-review-link" onClick={() => { handOff.current = true; onCreateReviewLink(); }}>Create Review link…</MenuPrimitive.Item>}
      </Submenu>}
      {remove && <>
        <MenuPrimitive.Separator className={SEPARATOR} />
        <MenuPrimitive.Item className={cn(MENU_ITEM, "text-destructive-wash-foreground")} disabled={remove.disabled} data-testid="video-card-delete" onClick={() => { handOff.current = true; remove.onOpen(); }}>Delete…</MenuPrimitive.Item>
      </>}
    </Menu>
    {pick.input}
  </>;
}

type UploadLineProps = {
  video: VideoDto;
  myUpload: VideoUploadState | undefined;
  currentUserId: string | null;
  /** The Version my upload becomes when the server has not numbered it yet. */
  nextNumber: number;
  /** The last file's refusal (`createVersionFileState`). */
  message: string | null;
  /** Asks the server to drop an upload this tab has no job for. */
  onCancelReservation: (reservationId: string) => Promise<void>;
};

/** The upload line under a tile's or row's title (progress, someone else's upload, Cancel upload, a refusal), or `null` when it has nothing to say: the slot is then left out. */
export function videoUploadLine(props: UploadLineProps): ReactNode {
  const { elsewhere } = videoUploadFacts(props.video, props.myUpload, props.currentUserId);
  return props.myUpload || elsewhere || props.message ? <VideoUploadLine {...props} /> : null;
}

function VideoUploadLine({ video, myUpload, currentUserId, nextNumber, message, onCancelReservation }: UploadLineProps) {
  const [cancelling, setCancelling] = useState(false);
  const { elsewhere, cancellable } = videoUploadFacts(video, myUpload, currentUserId);
  return <>
    {myUpload && <p role="status" className={`${META} flex items-center gap-[var(--space-2)]`} data-testid="video-card-uploading"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />{`Uploading v${myUpload.version ?? nextNumber} · ${myUpload.percent}%`}</p>}
    {elsewhere && !cancellable && <p role="status" className={`${META} flex items-center gap-[var(--space-2)]`} data-testid="video-card-uploading-other"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />{`${elsewhere.uploader.name} is uploading v${elsewhere.version}`}</p>}
    {cancellable && <p role="status" className={META} data-testid="video-card-uploading-other">{`Your upload of v${cancellable.version} is still open (another tab or device).`}</p>}
    {cancellable && <div className="flex flex-wrap gap-[var(--space-2)]">
      <Button type="button" variant="secondary" className="min-h-[44px]" disabled={cancelling} onClick={() => { setCancelling(true); void onCancelReservation(cancellable.reservationId).finally(() => setCancelling(false)); }}>{cancelling ? "Cancelling…" : "Cancel upload"}</Button>
    </div>}
    {message && <Notice tone="critical" role="alert">{message}</Notice>}
  </>;
}
