import { useId, type ReactNode } from "react";
import { Link2, Lock, MessageSquare, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { LazyImage } from "../LazyImage";
import { Badge } from "../reui/badge";
import { Frame, FramePanel } from "../reui/frame";
import { formatDuration } from "../video/video-format";
import { Checkbox } from "./Checkbox";
import { FileDropzone } from "./FileDropzone";
import type { StatusTone } from "./StatusPill";
import { TruncatedTitleTip } from "./TruncatedTitleTip";

/**
 * The one poster-first Video tile (#884; prototype T1-T5, D20-D28), staff and guest. It takes plain values rather than a DTO, so the Delivery page (#882) can hand it a published Version.
 * Staff-only pieces arrive as props (`status`, `linked`, `select`, `menu`, `drop`, `footer`); a tile given none of them is the guest tile. It imports nothing staff-only
 * (`guest/guest-boundary.guard.test.ts`). `tone="paper"` (#882, D30) is the light tile for the light Delivery page: a hairline border, the same black poster. `locked` (D37) is a Premium film the viewer has not unlocked:
 * a light box with a lock and "Film · locked" and no Version, duration or count (`version` and `durationMs` are null there, and also on a film with no review to open, D36).
 *
 * The whole tile opens: the title is the one open control and stretches over the tile (`after:inset-0`); the tick, the menu and the footer sit above it (`z-10`), so each is its own control.
 * With an `href` the open control is a native `<a>` in the same tab (#882, story 28: the Delivery page's review tile is one link, so open-in-new-tab and copy-link work); with `onOpen` it is a
 * `<button>`, for a tile whose open is an action rather than a navigation (a screen state, the plain player, an unlock request). `openLabel` renames it when the action is not "open this film".
 * `caption` (#882, V1/V3) is a line under the title that belongs to that one control: unlike `footer` it is not raised above the stretched control, so a tap on it is a tap on the tile, and it must hold
 * no control of its own (the locked film's "Request unlock" line). `openDisabled` makes the button inert but keeps it focusable (`aria-disabled`, not `disabled`), so focus stays where the viewer pressed.
 * A cut-off title shows in full in a tooltip on hover and keyboard focus of the open control (#934, `TruncatedTitleTip`; none on a coarse pointer). The node that truncates carries
 * `data-title-text` (the button itself, the link's inner span) and is what the tooltip measures; the tooltip shows the title even where `openLabel` renames the control.
 */
export type VideoTileStatus = { tone: StatusTone; /** Drawn beside the dot. */ short: string; /** Read aloud and in the tile's summary. */ full: string };

const DOT: Record<StatusTone, string> = { caution: "bg-signal-caution", positive: "bg-signal-positive", info: "bg-signal-info", critical: "bg-signal-critical", neutral: "bg-muted-foreground" };
const CHIP = "border-transparent bg-[var(--scrim-badge)] text-invert-foreground";
// The tick sits on a poster that may be any colour: a paper border on a translucent ink fill reads on dark and light alike (prototype tiles.jsx).
const TICK = "appearance-none relative rounded-[var(--radius-sm)] border-[length:var(--border-width-bold)] border-solid border-invert-foreground bg-[color-mix(in_srgb,var(--ink-900)_35%,transparent)] checked:bg-invert-foreground checked:before:absolute checked:before:left-[5px] checked:before:top-[1px] checked:before:h-[10px] checked:before:w-[5px] checked:before:rotate-45 checked:before:border-solid checked:before:border-b-2 checked:before:border-r-2 checked:before:border-invert checked:before:content-['']";
const MONO = "[font-family:var(--font-mono)]";
// The open control, link or button: 44px tall, one line of body type (truncated: the button's own text, the link's inner span, since a flex box does not ellipsize), stretched over the whole tile by its ::after.
const OPEN = "min-h-11 min-w-0 flex-1 text-foreground [font:var(--weight-regular)_var(--text-base)/var(--leading-normal)_var(--font-sans)] after:absolute after:inset-0 after:content-['']";

/** How the tile opens: a link (`href`, same tab) or an action (`onOpen`); never both. */
type VideoTileOpen =
  | { /** A same-tab address: the open control is a native `<a>`. */ href: string; onOpen?: undefined }
  | { /** `trigger` is the open control, where focus returns when the viewer closes. */ onOpen: (trigger: HTMLElement) => void; href?: undefined };

export function VideoTile({ title, posterUrl, version, durationMs, openNotes, href, onOpen, openLabel, openDisabled = false, tone = "ink", locked = false, status, linked, premium, select, menu, drop, footer, caption, testId = "video-tile", openTestId = "video-tile-open", dataVideoId }: VideoTileOpen & {
  title: string;
  posterUrl: string | null;
  /** Null where the page does not know or must not say (a locked film, or no review to open on the Delivery page): no chip, no words. */
  version: number | null;
  durationMs: number | null;
  /** Open root notes on `version`; null when unknown. Shown only above zero. */
  openNotes: number | null;
  /** The open control's accessible name when the tile does something other than open the film (a locked tile requests an unlock); it keeps the title in it. Default: the title. */
  openLabel?: string;
  /** The `onOpen` button does nothing and says so (`aria-disabled`), staying focusable: a locked tile whose unlock is sending, waiting out a rate limit, or already requested. */
  openDisabled?: boolean;
  tone?: "ink" | "paper";
  /** A locked Premium film (D37): no poster, no facts; `premium` is implied and drawn in the menu's place unless a `menu` is given. */
  locked?: boolean;
  status?: VideoTileStatus;
  /** On an active Review link (staff). */
  linked?: boolean;
  premium?: boolean;
  select?: { selected: boolean; onToggle: () => void };
  /** The "⋯" menu (staff), drawn beside the title. */
  menu?: ReactNode;
  /** Dropping a file on the poster uploads it as the next Version. */
  drop?: { nextVersion: number; onFile: (file: File) => void; disabled: boolean };
  /** Under the title: upload progress and refusals. */
  footer?: ReactNode;
  /** Under the title, part of the tile's one control (beneath its stretched ::after): text only, never a control. */
  caption?: ReactNode;
  testId?: string;
  openTestId?: string;
  dataVideoId?: string;
}) {
  const summaryId = useId();
  const noteWords = !locked && version !== null && openNotes !== null && openNotes > 0 ? `${openNotes} open ${openNotes === 1 ? "note" : "notes"} on v${version}` : null;
  const summary = [locked ? "Film, locked: Premium" : null, !locked && version !== null ? `v${version}` : null, !locked && durationMs !== null ? formatDuration(durationMs) : null, noteWords, status?.full].filter((part): part is string => part !== null && part !== undefined).join(", ");
  const lockedBody = <div data-testid={`${testId}-locked`} className="flex h-full w-full flex-col items-center justify-center gap-[var(--space-2)] bg-surface-sunken text-foreground-secondary">
    <Lock aria-hidden="true" className="size-6" /><span className="[font:var(--type-label)]">Film · locked</span>
  </div>;
  const posterBody = locked ? lockedBody : <>
    {posterUrl
      ? <LazyImage src={posterUrl} alt={`Poster of ${title}`} className="h-full w-full object-contain !bg-invert !text-invert-foreground" />
      : <div data-testid={`${testId}-no-poster`} className="flex h-full w-full items-center justify-center [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] opacity-70">No poster</div>}
    <div className="pointer-events-none absolute inset-x-[var(--space-2)] top-[var(--space-2)] flex items-start justify-between gap-[var(--space-2)]">
      <div className="flex min-w-0 items-start gap-[var(--space-1)]">
        {select && <span data-testid={`${testId}-pill-offset`} className="hidden h-11 w-11 shrink-0 group-hover/tile:block group-focus-within/tile:block group-data-[selected=true]/tile:block pointer-coarse:block max-[721px]:block" aria-hidden="true" />}
        {status && <Badge variant="invert" data-testid={`${testId}-status`} className={cn(CHIP, "gap-[var(--space-1)]")}><span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[status.tone])} />{status.short}</Badge>}
      </div>
      <div className="flex shrink-0 items-center gap-[var(--space-1)]">
        {premium && <Badge variant="invert" className={CHIP}>Premium</Badge>}
        {linked && <Badge variant="invert" data-testid={`${testId}-linked`} className={CHIP}><Link2 aria-hidden="true" /><span className="sr-only">On a Review link</span></Badge>}
        {version !== null && <Badge variant="invert" data-testid={`${testId}-version`} className={cn(CHIP, MONO, "normal-case")}>{`v${version}`}</Badge>}
      </div>
    </div>
    <div className="pointer-events-none absolute inset-x-[var(--space-2)] bottom-[var(--space-2)] flex items-end justify-between gap-[var(--space-2)]">
      {openNotes !== null && openNotes > 0 ? <Badge variant="invert" data-testid={`${testId}-open-notes`} className={cn(CHIP, "gap-[var(--space-1)] tabular-nums")}><MessageSquare aria-hidden="true" className="size-3" />{openNotes}</Badge> : <span />}
      {durationMs !== null ? <Badge variant="invert" className={cn(CHIP, MONO)}>{formatDuration(durationMs)}</Badge> : <span />}
    </div>
  </>;
  const posterClass = cn("relative aspect-video overflow-hidden", locked ? "bg-surface-sunken text-foreground-secondary" : "bg-invert text-invert-foreground");
  return <Frame
    data-testid={testId} data-video-id={dataVideoId} data-selected={select?.selected ? "true" : "false"} data-tone={tone} {...(tone === "ink" ? { "data-surface": "inverse" } : {})}
    className="group/tile gap-0 bg-background p-0 text-foreground data-[tone=paper]:border data-[tone=paper]:border-solid data-[tone=paper]:border-[var(--border-hairline)] [--frame-radius:var(--radius-md)] [--frame-panel-radius:var(--radius-md)] data-[selected=true]:border-[var(--border-strong)]"
  >
    <FramePanel className="flex flex-col gap-0 border-0 bg-transparent p-0">
      <Zone drop={drop} testId={testId}>
      <div data-testid={`${testId}-poster`} data-fit="contain" className={posterClass}>
        {posterBody}
        {drop && <div aria-hidden="true" className="absolute inset-0 hidden flex-col items-center justify-center gap-[var(--space-2)] bg-[var(--scrim-badge)] text-invert-foreground outline-dashed outline-[length:var(--border-width-bold)] -outline-offset-8 outline-invert-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] group-data-[dragging=true]/drop:flex"><Upload className="size-6" />{`Drop to upload v${drop.nextVersion}`}</div>}
      </div>
      {select && <label className="absolute left-0 top-0 z-10 flex size-11 cursor-pointer items-center justify-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/tile:opacity-100 group-data-[selected=true]/tile:opacity-100 pointer-coarse:opacity-100 max-[721px]:opacity-100">
        <Checkbox aria-label={`Select ${title}`} checked={select.selected} onChange={select.onToggle} className={TICK} />
      </label>}
      <div className="flex items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)]">
        <TruncatedTitleTip text={title}>
          {href !== undefined
            ? <a href={href} data-testid={openTestId} data-video-id={dataVideoId} aria-describedby={summaryId} aria-label={openLabel} className={cn(OPEN, "flex items-center no-underline")}><span data-title-text="" className="min-w-0 truncate">{title}</span></a>
            : <button
              type="button" data-testid={openTestId} data-video-id={dataVideoId} data-title-text="" aria-describedby={summaryId} aria-label={openLabel} aria-disabled={openDisabled ? true : undefined}
              onClick={(event) => { if (!openDisabled) onOpen?.(event.currentTarget); }}
              className={cn(OPEN, "cursor-pointer truncate border-0 bg-transparent p-0 text-left aria-disabled:cursor-default")}
            >{title}</button>}
        </TruncatedTitleTip>
        <span id={summaryId} className="sr-only">{summary}</span>
        {menu && <div className="relative z-10 shrink-0">{menu}</div>}
      </div>
      {caption && <div className="px-[var(--space-3)] pb-[var(--space-3)]">{caption}</div>}
      {footer && <div className="relative z-10 grid gap-[var(--space-2)] px-[var(--space-3)] pb-[var(--space-3)]">{footer}</div>}
      </Zone>
    </FramePanel>
  </Frame>;
}

/** The whole tile is the drop target when a `drop` is given, so the stretched open control (its ::after covers the poster) is inside the zone, not over it. */
function Zone({ drop, testId, children }: { drop: { onFile: (file: File) => void; disabled: boolean } | undefined; testId: string; children: ReactNode }) {
  if (!drop) return <>{children}</>;
  return <FileDropzone data-testid={`${testId}-drop`} disabled={drop.disabled} onFile={drop.onFile} className="group/drop relative flex flex-col">{children}</FileDropzone>;
}
