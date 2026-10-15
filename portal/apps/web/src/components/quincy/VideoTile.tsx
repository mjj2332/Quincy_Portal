import { useId, type ReactNode } from "react";
import { Link2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { LazyImage } from "../LazyImage";
import { Badge } from "../reui/badge";
import { Frame, FramePanel } from "../reui/frame";
import { formatDuration } from "../video/video-format";
import { Checkbox } from "./Checkbox";
import { FileDropzone } from "./FileDropzone";
import type { StatusTone } from "./StatusPill";

/**
 * The one poster-first Video tile (#884; prototype T1-T5, D20-D28), staff and guest. It takes plain values rather than a DTO, so the Delivery page (#882) can hand it a published Version.
 * Staff-only pieces arrive as props (`status`, `linked`, `select`, `menu`, `drop`, `footer`); a tile given none of them is the guest tile. It imports nothing staff-only
 * (`guest/guest-boundary.guard.test.ts`). `tone="paper"` is the #882 seam: only the ink look is built.
 *
 * The whole tile opens: the title is the one `<button>` and stretches over the tile (`after:inset-0`); the tick, the menu and the footer sit above it (`z-10`), so each is its own control.
 */
export type VideoTileStatus = { tone: StatusTone; /** Drawn beside the dot. */ short: string; /** Read aloud and in the tile's summary. */ full: string };

const DOT: Record<StatusTone, string> = { caution: "bg-signal-caution", positive: "bg-signal-positive", info: "bg-signal-info", critical: "bg-signal-critical", neutral: "bg-muted-foreground" };
const CHIP = "border-transparent bg-[var(--scrim-badge)] text-invert-foreground";
// The tick sits on a poster that may be any colour: a paper border on a translucent ink fill reads on dark and light alike (prototype tiles.jsx).
const TICK = "appearance-none relative rounded-[var(--radius-sm)] border-[length:var(--border-width-bold)] border-solid border-invert-foreground bg-[color-mix(in_srgb,var(--ink-900)_35%,transparent)] checked:bg-invert-foreground checked:before:absolute checked:before:left-[5px] checked:before:top-[1px] checked:before:h-[10px] checked:before:w-[5px] checked:before:rotate-45 checked:before:border-solid checked:before:border-b-2 checked:before:border-r-2 checked:before:border-invert checked:before:content-['']";
const MONO = "[font-family:var(--font-mono)]";

export function VideoTile({ title, posterUrl, version, durationMs, openNotes, onOpen, tone = "ink", status, linked, premium, select, menu, drop, footer, testId = "video-tile", openTestId = "video-tile-open", dataVideoId }: {
  title: string;
  posterUrl: string | null;
  version: number;
  durationMs: number;
  /** Open root notes on `version`; null when unknown. Shown only above zero. */
  openNotes: number | null;
  /** `trigger` is the open control, where focus returns when the viewer closes. */
  onOpen: (trigger: HTMLElement) => void;
  tone?: "ink" | "paper";
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
  testId?: string;
  openTestId?: string;
  dataVideoId?: string;
}) {
  const summaryId = useId();
  const noteWords = openNotes !== null && openNotes > 0 ? `${openNotes} open ${openNotes === 1 ? "note" : "notes"} on v${version}` : null;
  const summary = [`v${version}`, formatDuration(durationMs), noteWords, status?.full].filter((part): part is string => part !== null && part !== undefined).join(", ");
  const posterBody = <>
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
        <Badge variant="invert" data-testid={`${testId}-version`} className={cn(CHIP, MONO, "normal-case")}>{`v${version}`}</Badge>
      </div>
    </div>
    <div className="pointer-events-none absolute inset-x-[var(--space-2)] bottom-[var(--space-2)] flex items-end justify-between gap-[var(--space-2)]">
      {openNotes !== null && openNotes > 0 ? <Badge variant="invert" data-testid={`${testId}-open-notes`} className={cn(CHIP, "tabular-nums")}>{openNotes}</Badge> : <span />}
      <Badge variant="invert" className={cn(CHIP, MONO)}>{formatDuration(durationMs)}</Badge>
    </div>
  </>;
  const posterClass = "relative aspect-video overflow-hidden bg-invert text-invert-foreground";
  return <Frame
    data-testid={testId} data-video-id={dataVideoId} data-selected={select?.selected ? "true" : "false"} data-tone={tone} {...(tone === "ink" ? { "data-surface": "inverse" } : {})}
    className="group/tile gap-0 bg-background p-0 text-foreground [--frame-radius:var(--radius-md)] [--frame-panel-radius:var(--radius-md)] data-[selected=true]:border-[var(--border-strong)]"
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
        <button
          type="button" data-testid={openTestId} data-video-id={dataVideoId} aria-describedby={summaryId}
          onClick={(event) => { onOpen(event.currentTarget); }}
          className="min-h-11 min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-foreground [font:var(--weight-regular)_var(--text-base)/var(--leading-normal)_var(--font-sans)] after:absolute after:inset-0 after:content-['']"
        >{title}</button>
        <span id={summaryId} className="sr-only">{summary}</span>
        {menu && <div className="relative z-10 shrink-0">{menu}</div>}
      </div>
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
