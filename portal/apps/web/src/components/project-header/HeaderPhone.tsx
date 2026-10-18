import { useRef, type ReactNode } from "react";
import { ChevronDownIcon, NotebookPenIcon, XIcon } from "lucide-react";
import { Button } from "@/components/reui/button";
import { StageDot } from "../atoms";
import { useClaimSheetClose, useProjectSheet } from "../quincy/ProjectSheet";
import { deadlineCountdown, type DeadlineDueInTone } from "../../lib/deadline-due-in";
import type { useStages } from "../../lib/stages";
import type { ProjectDetail } from "../../lib/project-data";
import { cn } from "../../lib/utils";
import { useMinuteNow } from "../../lib/use-minute-now";
import { WhiteboardButton } from "./WhiteboardButton";
import { ArchivedBadge } from "./ArchivedBadge";
import { META_DOT, stageLabel } from "./header-parts";
import { deadlineChipDate } from "../ProjectHeaderDeadline";
import { twinHandOff, useScrolledOut } from "./use-scrolled-out";

const DUE_TONE: Record<DeadlineDueInTone, string> = { caution: "text-signal-caution-text", critical: "text-signal-critical", neutral: "" };

/** The 44px ghost buttons at the bars' ends (Whiteboard, Close, M1 `.m-wb`). */
const BAR_ICON_BUTTON = "min-h-[44px] min-w-[44px] shrink-0" /* WCAG 2.5.5 Enhanced target, not a spacing token */;


/** Close project, in whichever bar is live: the header claims the Project sheet's own Close while the phone tree is mounted. */
function CloseProject({ onClose }: { onClose: () => void }) {
  return <Button type="button" variant="ghost" size="icon" aria-label="Close project" data-testid="project-header-close" data-twin="close" className={BAR_ICON_BUTTON} onClick={onClose}>
    <XIcon aria-hidden="true" className="size-5" />
  </Button>;
}

export type HeaderPhoneProps = {
  project: ProjectDetail;
  currentStageKey: ProjectDetail["stageKey"];
  stages: ReturnType<typeof useStages>["stages"];
  tabs: ReactNode;
  /** Project info, rendered beside the bars. */
  info?: ReactNode;
  infoOpen: boolean;
  onOpenInfo: (opener: HTMLElement) => void;
  onOpenWhiteboard?: () => void;
  whiteboardOpen: boolean;
  /** Story 44: the Project is archived (the detail or the #455 latch); the bar carries the D6 Archived badge. */
  archived: boolean;
};

/**
 * #914 M1/M2 — the phone header (the Project sheet's full-screen width, PROJECT_SHEET_PHONE_QUERY). Three siblings under `main.work`,
 * so each sticks against the whole work area (app.css):
 *
 * - the slim bar (M2), 48px: the name and Close. Sticky at the top with a matching negative margin, so it takes no room, and inert
 *   and transparent until the project bar has scrolled under it.
 * - the project bar (M1), the labelled section: the title, then the Stage, the due date and a Notes marker, all one target that
 *   opens Project info; then Whiteboard and Close behind a hairline. Inert while the slim bar is live.
 * - the Workspace tabs, sticky under the slim bar.
 *
 * Exactly one Close is live at a time, and it is the header's: the sheet's own is claimed away while this tree is mounted (loading,
 * error and Collaboration-only views never mount it, so they keep the sheet's). Focus on a bar that is swapped out moves to its twin.
 */
export function HeaderPhone({ project, currentStageKey, stages, tabs, info, infoOpen, onOpenInfo, onOpenWhiteboard, whiteboardOpen, archived }: HeaderPhoneProps) {
  const sheet = useProjectSheet();
  useClaimSheetClose(sheet !== null);
  const barRef = useRef<HTMLElement>(null);
  const slimRef = useRef<HTMLDivElement>(null);
  const slim = useScrolledOut(barRef, project.id, !whiteboardOpen, {
    rootMargin: "-48px 0px 0px 0px",
    handOff: (next) => next ? twinHandOff(barRef.current, () => slimRef.current) : twinHandOff(slimRef.current, () => barRef.current),
  });
  const now = useMinuteNow();

  const name = `Project info, ${project.street}`;
  const stage = stageLabel(stages, currentStageKey);
  const deadline = project.deadlineSchedule.deadline;
  // Story 3: an inactive deadline (Delivered or archived) keeps its date, read-only with no countdown, as the desktop's flat chip.
  const due = deadlineCountdown(project.deadlineSchedule, now) ?? (deadline ? { tone: "neutral" as const, label: `Due ${deadlineChipDate(deadline.localCivil)}` } : null);
  const hasNotes = Boolean(project.productionNotes?.trim());
  const close = sheet ? () => sheet.close() : null;
  const openInfo = (event: { currentTarget: HTMLElement }) => onOpenInfo(event.currentTarget);

  return <>
    <div ref={slimRef} className="project-phone__slim" data-testid="project-header-slim" data-twin-bar="" data-on={slim ? "" : undefined} inert={!slim}>
      <Button type="button" variant="ghost" aria-label={name} aria-haspopup="dialog" aria-expanded={infoOpen} data-twin="info"
        className="h-auto min-h-[44px] min-w-0 flex-1 justify-start gap-[var(--space-2)] px-0 normal-case tracking-normal text-foreground [font:var(--weight-regular)_var(--text-md)/1_var(--font-display)]"
        onClick={openInfo}>
        <span className="truncate">{project.street}</span><ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Button>
      {close && <CloseProject onClose={close} />}
    </div>
    <section ref={barRef} className="project-phone__bar" aria-label="Project Overview" data-testid="project-header" data-twin-bar="" inert={slim}>
      <div className="flex min-w-0 items-center">
        {/* One target over the title, its chevron and the subline: the button is stretched across them, since a heading cannot
            sit inside a button. */}
        <div className="relative grid min-h-[44px] min-w-0 flex-1 content-center gap-[var(--space-1)] pe-[var(--space-3)]">
          <div className="flex min-w-0 items-center gap-[var(--space-1)]">
            <h2 className="m-0 truncate text-foreground tracking-[var(--tracking-tight)] [font:var(--weight-regular)_var(--text-lg)/var(--leading-snug)_var(--font-display)]">{project.street}</h2>
            <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {archived && <ArchivedBadge data-testid="project-header-phone-archived" className="ms-[var(--space-1)] shrink-0" />}
          </div>
          <p className="m-0 flex min-w-0 items-center gap-[var(--space-2)] overflow-hidden whitespace-nowrap text-foreground-secondary [font:var(--type-label)]" data-testid="project-header-phone-sub">
            {/* The Stage label gives way (an ellipsis) before the due date and the Notes marker do. */}
            <span className="inline-flex min-w-0 items-center gap-[var(--space-2)]"><StageDot stageKey={currentStageKey} /><span className="truncate" data-testid="project-header-phone-stage">{stage}</span></span>
            {due && <>{META_DOT}<span className={cn("shrink-0", DUE_TONE[due.tone])} data-tone={due.tone}>{due.label}</span></>}
            {hasNotes && <>{META_DOT}<span className="inline-flex shrink-0 items-center gap-[var(--space-1)] text-foreground" data-testid="project-header-phone-notes"><NotebookPenIcon aria-hidden="true" className="size-3.5" />Notes</span></>}
          </p>
          <Button type="button" variant="ghost" aria-label={name} aria-haspopup="dialog" aria-expanded={infoOpen} data-twin="info"
            className="absolute inset-0 h-auto rounded-[var(--radius-sm)] p-0 hover:bg-transparent aria-expanded:bg-transparent" onClick={openInfo} />
        </div>
        <span aria-hidden="true" className="ms-[var(--space-1)] block h-7 w-px shrink-0 bg-border" />
        {onOpenWhiteboard && <WhiteboardButton variant="bar" onOpen={onOpenWhiteboard} />}
        {close && <CloseProject onClose={close} />}
      </div>
    </section>
    <div className={cn("project-header__tabbar project-header__tabbar--phone")} data-testid="project-header-tabbar" data-stuck={slim ? "" : undefined}>{tabs}</div>
    {info}
  </>;
}
