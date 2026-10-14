import { useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { videoVersionDownloadUrl, type VideoDto } from "@quincy/shared";
import { Button } from "../quincy/Button";
import { Spinner } from "../reui/spinner";
import { Notice } from "../quincy/Notice";
import { useFilePick } from "../quincy/FileDropzone";
import { VideoTile } from "../quincy/VideoTile";
import type { VideoUploadState } from "../../lib/video-upload";
import { IconButton } from "../quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { cn } from "@/lib/utils";
import { REVIEW_STATUS_LABEL, REVIEW_STATUS_SHORT, REVIEW_STATUS_TONE } from "./VideoReviewStatusPill";
import type { ReviewLinkChip } from "./use-review-links-ui";

const META = "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";

export const VIDEO_ACCEPT = ".mp4,.mov,video/mp4,video/quicktime";

/** A submenu's popup: the menu panel's paint (`quincy/menu`'s PANEL), drawn here because the shared one is private to its file. */
const SUB_PANEL = "z-[var(--z-popover)] w-56 max-w-[min(320px,calc(100vw-var(--space-4)))] max-h-[min(420px,calc(100dvh-var(--space-5)))] overflow-auto border border-border bg-popover text-popover-foreground shadow-[var(--shadow-md)] outline-none";
const SEPARATOR = "my-[var(--space-1)] h-px bg-border";

function Submenu({ label, testId, trigger, children }: { label: string; testId: string; trigger: ReactNode; children: ReactNode }) {
  return <MenuPrimitive.SubmenuRoot>
    <MenuPrimitive.SubmenuTrigger className={cn(MENU_ITEM, "justify-between gap-[var(--space-2)]")} data-testid={testId}>{trigger}<ChevronRight aria-hidden="true" className="size-4 shrink-0" /></MenuPrimitive.SubmenuTrigger>
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side="right" align="start" sideOffset={2} collisionPadding={8} className="z-[var(--z-popover)] outline-none">
        <MenuPrimitive.Popup className={SUB_PANEL} aria-label={label}>{children}</MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  </MenuPrimitive.SubmenuRoot>;
}

/**
 * One Video as a poster-first tile (#884, was the #741 4d-i card). The whole tile opens the review; "⋯" is its only button and holds everything the card's buttons did. Dropping a file on the poster
 * uploads it as the next Version. `onVersionFile` checks and starts the upload and returns a message when the file is refused.
 */
export function VideoCard({ video, canUpload, currentUserId, myUpload, onVersionFile, onCancelReservation, onOpen, reviewLinks, onCreateReviewLink, download, onRename, remove }: {
  video: VideoDto;
  canUpload: boolean;
  currentUserId: string | null;
  /** My running upload of a new Version of this Video in this tab, if any. */
  myUpload?: VideoUploadState;
  /** Resolves `null` once the server holds the upload, else the reason it was refused (or the file was). */
  onVersionFile: (video: VideoDto, file: File) => Promise<string | null>;
  /** Asks the server to drop an upload this tab has no job for. */
  onCancelReservation: (reservationId: string) => Promise<void>;
  /** Opens the review player on this Video, on `version` when given; `trigger` is where focus returns on close. */
  onOpen: (video: VideoDto, trigger: HTMLElement, version?: number) => void;
  /** Present when staff may download (the `download` part and the capability): "⋯" then offers the current Version as an attachment (#866). */
  download?: { projectId: string };
  /** Present only when new Review links may be made (#834): the Review links submenu then offers Create Review link for this film. Absent on an archived Project. */
  onCreateReviewLink?: () => void;
  /** Present when the person may rename (#867: whoever may upload, on an unarchived Project). The dialog is hosted by the panel, above the filtered list. */
  onRename?: (video: VideoDto) => void;
  /** Present when staff may delete (the `trash` part and the capability, #868): "⋯" then ends with Delete…, in its own group. `disabled` on an archived Project. */
  remove?: { disabled: boolean; onOpen: () => void };
  /** Review links (#741 11b), present only when the links part is on and the role may share: the tick for a new link and the links this Video is on. */
  reviewLinks?: { selected: boolean; /** Absent when the Project is archived: no new links. */ onToggle?: () => void; chips: ReviewLinkChip[]; onOpenChip: (linkId: string) => void; onOpenAll: () => void };
}) {
  // The menu closes before a dialog has focus: while an item hands off, the menu moves no focus (#463); the dialog returns focus to the "⋯" button itself.
  const handOff = useRef(false);
  // The viewer's focus-return target (#866): the "⋯" button itself, never a menu item, which is portalled and gone once the menu closes.
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const newest = video.versions.find((version) => version.current) ?? video.versions[0]!;
  const nextNumber = Math.max(...video.versions.map((version) => version.version)) + 1;
  // The server says an upload is in flight and this tab has no job for it: someone else's, or mine that this tab lost (a reload, another device). Only its owner may cancel it.
  const uploadingElsewhere = !myUpload && video.uploading;
  const cancellable = uploadingElsewhere && currentUserId !== null && uploadingElsewhere.uploader.id === currentUserId ? uploadingElsewhere : null;
  const busy = Boolean(myUpload || video.uploading);
  const activeLinks = reviewLinks?.chips.filter((chip) => chip.status === "active") ?? [];
  const sendFile = (file: File) => { setMessage(null); setChecking(true); void onVersionFile(video, file).then((refused) => setMessage(refused)).finally(() => setChecking(false)); };
  const pick = useFilePick({ accept: VIDEO_ACCEPT, onFile: sendFile });
  const canUploadNow = canUpload && !busy;
  const openAt = (version: number) => { handOff.current = true; onOpen(video, menuTrigger.current ?? document.body, version); };

  const menu = <>
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
      {download && <MenuPrimitive.LinkItem closeOnClick className={MENU_ITEM} data-testid="video-card-download" href={videoVersionDownloadUrl(download.projectId, video.currentAssetId)} download>{`Download v${newest.version}`}</MenuPrimitive.LinkItem>}
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

  const footer = (myUpload || (uploadingElsewhere && !cancellable) || cancellable || message)
    ? <>
      {myUpload && <p role="status" className={`${META} flex items-center gap-[var(--space-2)]`} data-testid="video-card-uploading"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />{`Uploading v${myUpload.version ?? nextNumber} · ${myUpload.percent}%`}</p>}
      {uploadingElsewhere && !cancellable && <p role="status" className={`${META} flex items-center gap-[var(--space-2)]`} data-testid="video-card-uploading-other"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />{`${uploadingElsewhere.uploader.name} is uploading v${uploadingElsewhere.version}`}</p>}
      {cancellable && <p role="status" className={META} data-testid="video-card-uploading-other">{`Your upload of v${cancellable.version} is still open (another tab or device).`}</p>}
      {cancellable && <div className="flex flex-wrap gap-[var(--space-2)]">
        <Button type="button" variant="secondary" className="min-h-[44px]" disabled={cancelling} onClick={() => { setCancelling(true); void onCancelReservation(cancellable.reservationId).finally(() => setCancelling(false)); }}>{cancelling ? "Cancelling…" : "Cancel upload"}</Button>
      </div>}
      {message && <Notice tone="critical" role="alert">{message}</Notice>}
    </>
    : null;

  return <VideoTile
    testId="video-card" openTestId="video-card-open" dataVideoId={video.id}
    title={video.title} posterUrl={newest.posterUrl} version={newest.version} durationMs={newest.durationMs} openNotes={video.latestNoteCount}
    status={{ tone: REVIEW_STATUS_TONE[video.reviewStatus], short: REVIEW_STATUS_SHORT[video.reviewStatus], full: `${REVIEW_STATUS_LABEL[video.reviewStatus]}${video.olderPublishedVersion !== null ? `, v${video.olderPublishedVersion} published` : ""}` }}
    {...(video.premium ? { premium: true } : {})}
    {...(activeLinks.length > 0 ? { linked: true } : {})}
    onOpen={(trigger) => { onOpen(video, trigger); }}
    {...(reviewLinks?.onToggle ? { select: { selected: reviewLinks.selected, onToggle: reviewLinks.onToggle } } : {})}
    menu={menu}
    {...(canUpload ? { drop: { nextVersion: nextNumber, disabled: busy || checking, onFile: sendFile } } : {})}
    {...(footer ? { footer } : {})}
  />;
}
