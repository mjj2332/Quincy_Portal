import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDown } from "lucide-react";
import { staffPathFor, videoVersionDownloadUrl, type Role, type VideoDto } from "@quincy/shared";
import { Badge } from "../reui/badge";
import { Button } from "../quincy/Button";
import { Frame, FramePanel } from "../reui/frame";
import { ItemGroup, Item, ItemContent, ItemDescription, ItemTitle } from "../reui/item";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../reui/popover";
import { Spinner } from "../reui/spinner";
import { LazyImage } from "../LazyImage";
import { Notice } from "../quincy/Notice";
import { FilePickButton } from "../quincy/FileDropzone";
import type { VideoUploadState } from "../../lib/video-upload";
import { copyText } from "../../lib/clipboard";
import { Checkbox } from "../quincy/Checkbox";
import { IconButton } from "../quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { VideoReviewStatusPill } from "./VideoReviewStatusPill";
import { formatDuration, formatFps, formatVideoDate } from "./video-format";
import { ReviewLinkChips } from "./ReviewLinkChips";
import type { ReviewLinkChip } from "./use-review-links-ui";

const META = "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";

export const VIDEO_ACCEPT = ".mp4,.mov,video/mp4,video/quicktime";

/** Controls and portalled popups inside a card: a press on one of these is theirs, never the card's select or open. */
const NESTED_CONTROL = 'button,a,input,label,[role^="menu"],[role~="dialog"]';
/** A press that began on the card itself. React events bubble through portals, so a popup's own click reaches the card's handler: `contains` is the DOM-tree test that rules those out. */
const onCardSurface = (event: { currentTarget: Element; target: EventTarget }) => event.currentTarget.contains(event.target as Node) && !(event.target as Element).closest(NESTED_CONTROL);

/**
 * One Video as a card (#741 4d-i): poster, newest Version, duration, a Versions list, and who is uploading. Open review (4d-ii) hands
 * the Video and the control that was pressed to `onOpen`; selection and note chips arrive in later slices. `onVersionFile` checks and
 * starts the upload and returns a message when the file is refused.
 */
export function VideoCard({ video, canUpload, currentUserId, myUpload, onVersionFile, onCancelReservation, onOpen, reviewLinks, onCreateReviewLink, projectId, download, appearance = { thumb: "fit", info: true }, reviewStatus, onRename }: {
  video: VideoDto;
  canUpload: boolean;
  currentUserId: string | null;
  /** My running upload of a new Version of this Video in this tab, if any. */
  myUpload?: VideoUploadState;
  /** Resolves `null` once the server holds the upload, else the reason it was refused (or the file was). */
  onVersionFile: (video: VideoDto, file: File) => Promise<string | null>;
  /** Asks the server to drop an upload this tab has no job for. */
  onCancelReservation: (reservationId: string) => Promise<void>;
  /** Opens the review player on this Video; `trigger` is where focus returns on close. */
  onOpen: (video: VideoDto, trigger: HTMLElement) => void;
  /** The Project this film is in: the "⋯" menu's Copy link builds the staff deep link from it (#866). */
  projectId: string;
  /** Present when staff may download (the `download` part and the capability): the "⋯" menu then offers the current Version as an attachment (#866). */
  download?: { projectId: string };
  /** Present only when new Review links may be made (#834): the card's "⋯" menu then offers Create Review link for this film. Absent on an archived Project. */
  onCreateReviewLink?: () => void;
  /** Review links (#741 11b), present only when the links part is on and the role may share: the tick for a new link and the links this Video is on. */
  /** The grid's Appearance choices (#865): how the poster fills its frame, and whether the descriptive text shows. */
  appearance?: { thumb: "fit" | "fill"; info: boolean };
  /** Present when the card shows the Review status pill (#865); the same pill as the viewer's, with its own test ids. */
  reviewStatus?: { projectId: string; role: Role; archived: boolean };
  /** Present when the person may rename (#867: whoever may upload, on an unarchived Project): the "⋯" menu then offers Rename. The dialog is hosted by the panel, above the filtered list. */
  onRename?: (video: VideoDto) => void;
  reviewLinks?: { selected: boolean; /** Absent when the Project is archived: no new links. */ onToggle?: () => void; chips: ReviewLinkChip[]; onOpenChip: (linkId: string) => void; onOpenAll: () => void };
}) {
  // The menu closes before the dialog has focus: while Create Review link hands off, the menu moves no focus (#463); the dialog returns focus to the menu button itself.
  const handOff = useRef(false);
  // The viewer's focus-return target (#866): the ⋯ button itself, never a menu item, which is portalled and gone once the menu closes.
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const newest = video.versions.find((version) => version.current) ?? video.versions[0]!;
  const nextNumber = Math.max(...video.versions.map((version) => version.version)) + 1;
  const portrait = newest.height > newest.width;
  // The server says an upload is in flight and this tab has no job for it: someone else's, or mine that this tab lost (a reload, another device). Only its owner may cancel it.
  const uploadingElsewhere = !myUpload && video.uploading;
  const cancellable = uploadingElsewhere && currentUserId !== null && uploadingElsewhere.uploader.id === currentUserId ? uploadingElsewhere : null;
  const busy = Boolean(myUpload || video.uploading);
  const count = video.versions.length;
  // A touch tap opens the film (no hover to select by); read per event, so a hybrid laptop's mouse still selects. `click.pointerType` is unreliable on iOS Safari, so the pointerdown's is kept.
  const lastPointer = useRef("mouse");
  const select = reviewLinks?.onToggle;
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (!onCardSurface(event)) return;
    if (lastPointer.current === "touch") { onOpen(video, event.currentTarget); return; }
    // No `detail` gating: a double click toggles twice (net unchanged), then `onDoubleClick` opens.
    select?.();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Only the card itself: Enter on Open review (or a menu trigger) belongs to that control.
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") { event.preventDefault(); onOpen(video, event.currentTarget); }
    else if (event.key === " ") { event.preventDefault(); select?.(); }
  };

  return <Frame
    data-testid="video-card" aria-label={video.title} role="group" tabIndex={0} data-selected={reviewLinks?.selected ? "true" : "false"}
    className="transition-colors hover:border-[var(--border-hover)] data-[selected=true]:border-[var(--border-strong)]"
    onPointerDown={(event) => { lastPointer.current = event.pointerType; }}
    onMouseDown={(event) => { if (event.detail > 1 && onCardSurface(event)) event.preventDefault(); }}
    onClick={onClick}
    onDoubleClick={(event) => { if (onCardSurface(event)) onOpen(video, event.currentTarget); }}
    onKeyDown={onKeyDown}
  >
    <FramePanel className="flex flex-col gap-[var(--space-3)] p-0">
      <div data-testid="video-card-poster" data-thumbnail={appearance.thumb} data-orientation={portrait ? "portrait" : "landscape"} className="relative aspect-video overflow-hidden bg-invert text-invert-foreground">
        {newest.posterUrl
          ? <LazyImage src={newest.posterUrl} alt={`Poster of ${video.title}`} className={`h-full w-full ${appearance.thumb === "fill" ? "object-cover" : "object-contain"}`} />
          : <div data-testid="video-card-no-poster" className="flex h-full w-full items-center justify-center [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] opacity-70">No poster</div>}
        <Badge variant="secondary" className="absolute left-[var(--space-2)] top-[var(--space-2)]">{`v${newest.version}`}</Badge>
        {video.premium && <Badge variant="warning" className="absolute right-[var(--space-2)] top-[var(--space-2)]">Premium</Badge>}
        <Badge variant="invert" className="absolute bottom-[var(--space-2)] right-[var(--space-2)] border border-invert-foreground/20 [font-family:var(--font-mono)]">{formatDuration(newest.durationMs)}</Badge>
      </div>
      <div className="grid gap-[var(--space-3)] px-[var(--space-4)] pb-[var(--space-4)]">
        <div className="grid gap-[var(--space-1)]">
          <div className="flex items-start justify-between gap-[var(--space-2)]">
            <h3 className="serif [font:var(--type-h3)]">{video.title}</h3>
            {reviewLinks?.onToggle && <label className="-mr-[var(--space-2)] -mt-[var(--space-2)] flex size-11 shrink-0 cursor-pointer items-center justify-center"><Checkbox aria-label={`Select ${video.title}`} checked={reviewLinks.selected} onChange={reviewLinks.onToggle} /></label>}
          </div>
          {reviewStatus && <div><VideoReviewStatusPill video={video} version={newest} comparing={false} testId="video-card-review-status" {...reviewStatus} /></div>}
          {appearance.info && <div className="flex flex-col items-start gap-[var(--space-1)]">
            {/* The count sits on the versions row, so a card's height is the same with or without open notes. */}
            <div className="flex items-center gap-[var(--space-2)]" data-testid="video-card-versions-row">
            <Popover>
              <PopoverTrigger render={<Button type="button" variant="text" className="-ml-[var(--space-2)] px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11" />}>{count === 1 ? "1 version" : `${count} versions`}<ChevronDown aria-hidden="true" className="size-3" /></PopoverTrigger>
              <PopoverContent align="start" aria-label={`Versions of ${video.title}`}>
                <PopoverTitle>Versions</PopoverTitle>
                <ItemGroup>
                  {video.versions.map((version) => <Item key={version.assetId} size="xs">
                    <ItemContent>
                      <ItemTitle>{`v${version.version}`}</ItemTitle>
                      <ItemDescription>{`${version.uploadedBy.name} · ${formatVideoDate(version.createdAt)} · ${formatFps(version.fps)}\u00a0fps`}</ItemDescription>
                    </ItemContent>
                  </Item>)}
                </ItemGroup>
              </PopoverContent>
            </Popover>
            {video.latestNoteCount !== null && video.latestNoteCount > 0 && <Badge variant="info-light" size="sm" data-testid="video-card-open-notes" className="tabular-nums">{video.latestNoteCount === 1 ? "1 open note" : `${video.latestNoteCount} open notes`}</Badge>}
            </div>
            {reviewLinks && reviewLinks.chips.length > 0 && <ReviewLinkChips chips={reviewLinks.chips} onOpenChip={reviewLinks.onOpenChip} onOpenAll={reviewLinks.onOpenAll} />}
            <p className={META} data-testid="video-card-meta">{`${count > 1 ? `v${newest.version} by` : "by"} ${newest.uploadedBy.name} · ${formatVideoDate(newest.createdAt)} · ${formatFps(newest.fps)}\u00a0fps`}</p>
          </div>}
        </div>
        {myUpload && <p role="status" className={`${META} flex items-center gap-[var(--space-2)]`} data-testid="video-card-uploading"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />{`Uploading v${myUpload.version ?? nextNumber} · ${myUpload.percent}%`}</p>}
        {uploadingElsewhere && !cancellable && <p role="status" className={`${META} flex items-center gap-[var(--space-2)]`} data-testid="video-card-uploading-other"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />{`${uploadingElsewhere.uploader.name} is uploading v${uploadingElsewhere.version}`}</p>}
        {cancellable && <p role="status" className={META} data-testid="video-card-uploading-other">{`Your upload of v${cancellable.version} is still open (another tab or device).`}</p>}
        {cancellable && <div className="flex flex-wrap gap-[var(--space-2)]">
          <Button type="button" variant="secondary" className="min-h-[44px]" disabled={cancelling} onClick={() => { setCancelling(true); void onCancelReservation(cancellable.reservationId).finally(() => setCancelling(false)); }}>{cancelling ? "Cancelling…" : "Cancel upload"}</Button>
        </div>}
        {message && <Notice tone="critical" role="alert">{message}</Notice>}
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <Button type="button" variant="primary" className="min-h-[44px]" data-testid="video-card-open" data-video-id={video.id} onClick={(event) => onOpen(video, event.currentTarget)}>Open review</Button>
          {canUpload && !busy && <FilePickButton
            accept={VIDEO_ACCEPT}
            variant="secondary"
            className="min-h-[44px]"
            disabled={checking}
            onFile={(file) => { setMessage(null); setChecking(true); void onVersionFile(video, file).then((refused) => setMessage(refused)).finally(() => setChecking(false)); }}
          >{checking ? "Checking…" : `Upload v${nextNumber}`}</FilePickButton>}
          <div className="ml-auto">
            <Menu
              triggerLabel="Film actions" label="Film menu" triggerTestId="video-card-menu"
              triggerRender={<IconButton ref={menuTrigger} data-video-id={video.id} />}
              triggerClassName="text-foreground"
              trigger={<span aria-hidden="true">⋯</span>}
              finalFocus={() => (handOff.current ? false : undefined)}
              onOpenChange={(isOpen) => { if (isOpen) handOff.current = false; }}
            >
              {/* Groups, in order: the film (Open, Create Review link) ‖ the file and its address (Download, Copy link) ‖ Rename (#867; Delete #868 joins it). Later tickets append items inside a group. */}
              <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-card-menu-open" onClick={() => { handOff.current = true; onOpen(video, menuTrigger.current ?? document.body); }}>Open</MenuPrimitive.Item>
              {onCreateReviewLink && <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-card-create-review-link" onClick={() => { handOff.current = true; onCreateReviewLink(); }}>Create Review link</MenuPrimitive.Item>}
              <MenuPrimitive.Separator className="my-[var(--space-1)] h-px bg-border" />
              {download && <MenuPrimitive.LinkItem closeOnClick className={MENU_ITEM} data-testid="video-card-download" href={videoVersionDownloadUrl(download.projectId, video.currentAssetId)} download>{`Download v${newest.version}`}</MenuPrimitive.LinkItem>}
              <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-card-copy-link" onClick={() => copyText(new URL(staffPathFor({ kind: "project", projectId, arrivalTab: "video", video: { id: video.id } }), window.location.origin).href)}>Copy link</MenuPrimitive.Item>
              {onRename && <>
                <MenuPrimitive.Separator className="my-[var(--space-1)] h-px bg-border" />
                <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-card-rename" onClick={() => { handOff.current = true; onRename(video); }}>Rename</MenuPrimitive.Item>
              </>}
            </Menu>
          </div>
        </div>
      </div>
    </FramePanel>
  </Frame>;
}
