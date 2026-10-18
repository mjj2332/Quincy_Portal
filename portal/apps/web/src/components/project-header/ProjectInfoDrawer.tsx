import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { CalendarDaysIcon, ChartGanttIcon, ChevronLeftIcon, ChevronRightIcon, LinkIcon, PencilIcon, PresentationIcon, XIcon } from "lucide-react";
import type { Role, WorkspaceTab } from "@quincy/shared";
import { Badge } from "@/components/reui/badge";
import { Button, buttonVariants } from "@/components/reui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/reui/drawer";
import { RadioGroup, RadioGroupItem } from "@/components/reui/radio-group";
import { StageDot } from "../atoms";
import { InternalLink } from "../InternalLink";
import { OverlayContainerContext } from "../OverlayContainerContext";
import { DropboxDetails, dropboxStatus } from "../ProjectHeaderDropbox";
import { ProjectDeadlineControl } from "../ProjectDeadlineControl";
import { COUNTDOWN_BADGE, deadlineChipDate } from "../ProjectHeaderDeadline";
import { ProjectTeamCombobox } from "../ProjectTeamCombobox";
import { ARCHIVED_HEADER_NOTICE_CLASS } from "../archived-notice";
import { AvatarStack } from "../quincy/AvatarStack";
import { ProjectSocialOverlayPicker } from "../quincy/ProjectSocialOverlayPicker";
import { useCopyProjectLink } from "../quincy/CopyProjectLinkButton";
import { useShowInDestinations } from "../quincy/ProjectShowIn";
import { deadlineCountdown } from "../../lib/deadline-due-in";
import { useProjectSocialOverlaysQuery, useVideoReviewQuery, type ProjectDetail, type ProjectMember } from "../../lib/project-data";
import type { useStages } from "../../lib/stages";
import type { ShowInDestination } from "../../lib/project-show-in";
import { KEYBOARD_MIN_PX, useVisualViewport } from "../../lib/use-visual-viewport";
import { cn } from "../../lib/utils";
import { useMinuteNow } from "../../lib/use-minute-now";
import { shootLongText } from "./info-sections";
import type { ProjectInfoPanelProps } from "./ProjectInfoPanel";
import { openWhiteboardFromInfo } from "./whiteboard-opener";
import { projectDetailsAction, stageLabel, uniqueByUser } from "./header-parts";
import { DROPBOX_BADGE } from "./header-styles";

/** The views Project info pushes on the phone (M3–M6). */
export type DrawerView = "info" | "stage" | "deadline" | "team" | "overlays" | "dropbox";

/** What the phone Stage view's move reports (the settled plan): it returns to Project info only on `saved`. */
export type StageMoveOutcome = "saved" | "cancelled" | "failed" | "archived";

export type ProjectInfoDrawerProps = Omit<ProjectInfoPanelProps, "target"> & {
  activeTab: WorkspaceTab;
  stage: {
    currentStageKey: ProjectDetail["stageKey"];
    stages: ReturnType<typeof useStages>["stages"];
    /** `moveProjectStage`, the contract on and the Project not archived. */
    canMove: boolean;
    pending: boolean;
    disabledReason: string | null;
    onMove: (stageKey: ProjectDetail["stageKey"]) => Promise<StageMoveOutcome | void>;
  };
  /** The Status group's Stage row: where a Stage refusal returns focus (#455). */
  stageRowRef: Ref<HTMLElement>;
};

// --- M3's chrome, in Quincy tokens -------------------------------------------------------------------------------------------
/** `.glabel`: a group's label, 12px uppercase in the secondary ink, on the rows' 20px gutter. */
const GROUP_LABEL = "m-0 block px-[calc(var(--space-4)+var(--space-1))] pt-[var(--space-4)] pb-[var(--space-2)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";
/** `.group`: the inset group on the raised paper between two hairlines. */
const GROUP = "bg-card border-y border-border";
/**
 * `.row`: 52px (no token: the prototype's row, above the 44px target), the 20px left gutter, a hairline between rows that starts
 * at the gutter. A row that opens a view is a button; a static row is a plain block.
 */
const ROW = "relative flex w-full min-h-[52px] items-center gap-[var(--space-3)] py-[calc(var(--space-1)+2px)] ps-[calc(var(--space-4)+var(--space-1))] pe-[var(--space-3)] text-start [font:var(--weight-regular)_var(--text-base)/var(--leading-snug)_var(--font-sans)] text-foreground [&+&]:before:absolute [&+&]:before:inset-x-0 [&+&]:before:start-[calc(var(--space-4)+var(--space-1))] [&+&]:before:top-0 [&+&]:before:h-px [&+&]:before:bg-[var(--border-subtle)]";
const ROW_BUTTON = cn(ROW, "h-auto justify-start rounded-none border-0 bg-transparent normal-case tracking-normal hover:bg-muted aria-expanded:bg-transparent");
const ROW_STATIC = cn(ROW, "outline-none focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring -outline-offset-2 focus-visible:!-outline-offset-2");
/** `.row .k`: the row's term, 92px wide (no token), in the secondary ink. */
const ROW_TERM = "w-[92px] shrink-0 text-foreground-secondary";
const ROW_VALUE = "flex min-w-0 flex-1 items-center justify-end gap-[var(--space-2)] text-end";
const ROW_CHEVRON = "size-[18px] shrink-0 text-[var(--text-muted)]";
/** `.acts .qb`: the 48px outline actions, two to a line. */
const ACTION = cn(buttonVariants({ variant: "outline", size: "header" }), "min-h-[var(--space-7)] justify-center no-underline text-foreground [font:var(--weight-regular)_var(--text-base)/1.2_var(--font-sans)]");
const NOTES = "m-0 mx-[var(--space-4)] whitespace-pre-wrap border border-border bg-card px-[var(--space-4)] py-[calc(var(--space-3)+2px)] [font:var(--weight-regular)_var(--text-base)/var(--leading-relaxed)_var(--font-body-serif)] text-foreground";
const QUIET = "m-0 px-[calc(var(--space-4)+var(--space-1))] py-[var(--space-3)] [font:var(--type-label)] text-foreground-secondary";

function firstName(member: ProjectMember): string {
  return (member.name || member.email).trim().split(/\s+/)[0] ?? "";
}

/** The head of the info view (`.sh-head`): the street and the suburb; ×. The frame sets the street at 26px, which has no type
 *  rung; it renders at the nearest, `--text-xl` (28px), and a street too long for the line wraps anywhere rather than overflowing. */
function InfoHead({ street, place }: { street: string; place: string }) {
  return <div className="flex shrink-0 items-start gap-[var(--space-2)] ps-[calc(var(--space-4)+var(--space-1))] pe-[var(--space-2)] pt-[calc(var(--space-2)+2px)] pb-[calc(var(--space-3)+2px)]">
    <div className="grid min-w-0 flex-1 gap-[2px] pt-[calc(var(--space-1)+2px)]">
      <DrawerTitle className="m-0 text-foreground tracking-[var(--tracking-tight)] [font:var(--weight-regular)_var(--text-xl)/var(--leading-snug)_var(--font-display)] [overflow-wrap:anywhere]">{street}</DrawerTitle>
      {place && <span className="[font:var(--type-label)] text-foreground-secondary">{place}</span>}
    </div>
    <CloseInfo />
  </div>;
}

function CloseInfo() {
  return <DrawerClose data-testid="project-info-close" aria-label="Close Project info" render={<Button type="button" variant="ghost" size="icon-header" className="shrink-0 rounded-[var(--radius-pill)]" />}>
    <XIcon aria-hidden="true" className="size-5" />
  </DrawerClose>;
}

/** A pushed view's bar (`.sh-nav`): Back named for the parent ("Info", the iOS convention), the view's title centred, ×. */
function ViewNav({ title, backRef, onBack }: { title: string; backRef: Ref<HTMLButtonElement>; onBack: () => void }) {
  return <div className="relative flex min-h-[56px] shrink-0 items-center gap-[var(--space-1)] px-[var(--space-2)] pt-[calc(var(--space-1)+2px)] pb-[calc(var(--space-2)+2px)]">
    <Button ref={backRef} type="button" variant="ghost" data-testid="project-info-back" aria-label="Back to Project info" className="h-auto min-h-[44px] gap-[2px] ps-[var(--space-1)] pe-[var(--space-2)] normal-case tracking-normal text-info [font:var(--weight-regular)_var(--text-base)/1_var(--font-sans)]" onClick={onBack}>
      <ChevronLeftIcon aria-hidden="true" className="size-5" />Info
    </Button>
    <DrawerTitle className="pointer-events-none absolute start-1/2 m-0 -translate-x-1/2 whitespace-nowrap text-foreground [font:var(--weight-regular)_var(--text-md)/1_var(--font-display)]">{title}</DrawerTitle>
    <span className="ms-auto"><CloseInfo /></span>
  </div>;
}

const VIEW_BODY = "min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(var(--space-6),env(safe-area-inset-bottom))]";

/**
 * #914 M3–M6 — Project info on the phone: a bottom sheet over the Project sheet, 96px (`--space-9`) from its top so the Project
 * stays in view, with pushed views for Stage (M4), Deadline (M5), Team (M6) and Dropbox.
 *
 * Reuse: `reui/drawer` (Base UI 1.7.0 Drawer, installed for #914). Docking as the desktop sheet (`ProjectInfoSheet`): it portals
 * into the Project sheet's overlay slot and its scrim, viewport and popup are `absolute`, `z-[40]` above the sheet's Close; the
 * scrim needs `forceRender` under the nested Root. × , a scrim press, a drag down and Esc close Project info only (the Project
 * sheet counts the open drawer as an inner layer); Esc closes it from a pushed view too (settled decision), Back pops the view.
 * Focus goes back to the opener synchronously in `onOpenChange(false)` (#669).
 *
 * Read-only roles, External editors and an archived Project get plain rows: a view that edits is never offered, and one that is
 * open when the latch flips (#455) gives way to the info view in the same render, so the latch can focus its row.
 *
 * M6: while the Team view is up, the drawer's viewport (never the popup, whose transform Base UI owns for the swipe) follows the
 * visual viewport (`useVisualViewport`, #891), so the search and the results stay above the keyboard; one mechanism, so
 * `Drawer.VirtualKeyboardProvider` is not used.
 */
export function ProjectInfoDrawer(props: ProjectInfoDrawerProps) {
  const { project, archived, latch, canEdit, stage } = props;
  const container = useContext(OverlayContainerContext);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [requested, setRequested] = useState<DrawerView>("info");
  const backRef = useRef<HTMLButtonElement>(null);
  const teamInputRef = useRef<HTMLInputElement>(null);
  const rows = useRef<Partial<Record<DrawerView, HTMLElement | null>>>({});
  const editable = canEdit && !archived;
  const overlays = props.overlays;
  // A view that is no longer allowed (the read-only edge, a capability gone) gives way to the info view in this very render.
  const allowed: Record<DrawerView, boolean> = { info: true, stage: stage.canMove, deadline: editable, team: editable, overlays: overlays !== null && overlays.canEdit && !archived, dropbox: props.dropbox !== null };
  const view: DrawerView = allowed[requested] ? requested : "info";
  // Each opening starts at the info view.
  useLayoutEffect(() => { if (!props.open) setRequested("info"); }, [props.open]);

  const box = useVisualViewport(props.open && view === "team", undefined, viewport, props.open && view === "team");
  const keyboard = box !== null && typeof window !== "undefined" && window.innerHeight - box.height >= KEYBOARD_MIN_PX;

  const changeOpen = (next: boolean) => {
    if (next) return;
    props.returnFocus()?.focus({ preventScroll: true });
    props.onClose();
  };
  function push(next: Exclude<DrawerView, "info">) {
    // Synchronously, so the focus below lands inside the tap: iOS raises the Team search's keyboard only then (lessons, #879 3b).
    flushSync(() => setRequested(next));
    if (next === "team") teamInputRef.current?.focus();
    else backRef.current?.focus({ preventScroll: true });
  }
  function pop() {
    const from = view;
    flushSync(() => setRequested("info"));
    rows.current[from]?.focus({ preventScroll: true });
  }
  // The action goes with the drawer: the board returns focus to the project bar's own Whiteboard button.
  const openWhiteboard = () => openWhiteboardFromInfo(() => changeOpen(false), props.onOpenWhiteboard);
  const rowRef = (name: DrawerView) => (element: HTMLElement | null) => { rows.current[name] = element; };

  let content: ReactNode;
  if (view === "stage") {
    content = <>
      <ViewNav title="Stage" backRef={backRef} onBack={pop} />
      <div className={VIEW_BODY}>
        <StageView stage={stage} onSaved={pop} />
      </div>
    </>;
  } else if (view === "deadline") {
    content = <>
      <ViewNav title="Deadline" backRef={backRef} onBack={pop} />
      <ProjectDeadlineControl projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} layout="phone"
        onClose={pop} onArchivedRefusal={() => props.latchArchived("deadline", true)} />
    </>;
  } else if (view === "team") {
    content = <>
      <ViewNav title="Team" backRef={backRef} onBack={pop} />
      <ProjectTeamCombobox presentation="inline" fill projectId={project.id} members={project.members} canEdit={canEdit} archived={archived} inputRef={teamInputRef} onArchivedRefusal={() => props.latchArchived("team", false)} />
    </>;
  } else if (view === "overlays" && overlays) {
    content = <>
      <ViewNav title="Social overlays" backRef={backRef} onBack={pop} />
      <div className={cn(VIEW_BODY, "px-[var(--space-4)] pt-[var(--space-2)]")}>
        {/* The refusal takes this view away (the latch), so focus goes to the Status row: "inside" is true. */}
        <VideoReviewGate projectId={project.id} role={overlays.role}>
          <div data-testid="project-header-social-overlays">
            <ProjectSocialOverlayPicker key={project.id} projectId={project.id} role={overlays.role} canEdit={overlays.canEdit} archived={archived} onArchivedRefusal={() => props.latchArchived("social-overlays", true)} />
          </div>
        </VideoReviewGate>
      </div>
    </>;
  } else if (view === "dropbox" && props.dropbox) {
    content = <>
      <ViewNav title="Dropbox" backRef={backRef} onBack={pop} />
      <div className={cn(VIEW_BODY, "px-[var(--space-4)] pt-[var(--space-2)]")}>
        <DropboxDetails project={project} isSyncing={props.dropbox.isSyncing} autohdrBlocked={props.dropbox.autohdrBlocked} onSyncDropbox={props.dropbox.onSyncDropbox} archived={archived} archivedNotice={latch === "dropbox"} readOnlyRef={props.dropbox.readOnlyRef} onArchivedRefusal={(inside) => props.latchArchived("dropbox", inside)} />
      </div>
    </>;
  } else {
    content = <>
      <InfoHead street={project.street} place={props.place} />
      <div className={VIEW_BODY} data-testid="project-info-body">
        <InfoView {...props} overlays={overlays} editable={editable} rowRef={rowRef} onPush={push} onOpenWhiteboard={props.onOpenWhiteboard ? openWhiteboard : undefined} />
      </div>
    </>;
  }

  return <Drawer open={props.open} onOpenChange={changeOpen} swipeDirection="down">
    <DrawerContent
      ref={popupRef}
      container={container}
      data-testid="project-info-sheet"
      data-view={view}
      initialFocus={() => popupRef.current ?? true}
      finalFocus={() => props.returnFocus() ?? true}
      overlayProps={{ forceRender: true, "data-testid": "project-info-scrim", className: "absolute z-[40]" }}
      viewportProps={{ ref: setViewport, className: "absolute z-[40]" }}
      // 96px from the top (M3), 64px with the keyboard up (M6), on the warm paper with the 14px top radius. No `height` in the
      // transition (the vendor eases it over 450ms), so the 96 -> 64 switch never lags behind the keyboard. `focus-visible:!outline-none`:
      // initialFocus lands on the popup itself (#607, container-focus.guard). The vendor's bleed (the 3rem it paints under the popup,
      // seen while the keyboard drops: iOS resizes the visual viewport only once it is down) takes the popup's paper, not the popover white.
      className={cn(
        "absolute z-[40] max-h-none transition-[transform,opacity,filter] [--drawer-bleed-background:var(--background)] border-border bg-background text-foreground shadow-[var(--shadow-lg)] focus-visible:!outline-none data-[swipe-direction=down]:rounded-t-[var(--radius-lg)]",
        keyboard ? "h-[calc(100%-var(--space-8))]" : "h-[calc(100%-var(--space-9))]",
      )}
    >
      {/* `.handle`, decorative: the whole sheet takes the drag. 36×5 (no token: the prototype's grip). */}
      <span aria-hidden="true" className="mx-auto mt-[var(--space-2)] block h-[5px] w-9 shrink-0 rounded-[var(--radius-pill)] bg-[var(--border-hover)]" />
      {content}
    </DrawerContent>
  </Drawer>;
}

/**
 * M3's info view: Status (Stage, Deadline, Team, and Social overlays behind the Video review gate), Production notes, Client and
 * shoot, Files (Dropbox), then the actions (Open whiteboard first). Rows that open a view are buttons with a chevron; read-only
 * rows are plain and focusable only by script (a refusal's focus target).
 */
function InfoView({ project, archived, latch, canEdit, canAdminBackend, stage, stageRowRef, deadlineSectionRef, overlaysSectionRef, overlays, dropbox, editable, rowRef, onPush, onOpenWhiteboard, activeTab }: ProjectInfoDrawerProps & {
  editable: boolean;
  rowRef: (name: DrawerView) => (element: HTMLElement | null) => void;
  onPush: (view: Exclude<DrawerView, "info">) => void;
  onOpenWhiteboard?: () => void;
}) {
  const currentLabel = stageLabel(stage.stages, stage.currentStageKey);
  const schedule = project.deadlineSchedule;
  const countdown = deadlineCountdown(schedule, useMinuteNow());
  const people = uniqueByUser(project.members);
  const details = projectDetailsAction(project, { canEdit, archived, canAdminBackend });
  const status = dropboxStatus(project, dropbox?.autohdrBlocked ?? false, archived);
  const notes = project.productionNotes?.trim();
  const shoot = shootLongText(project) ?? "Date pending";

  const stageValue = <span className={ROW_VALUE}><StageDot stageKey={stage.currentStageKey} /><span className="truncate">{currentLabel}</span></span>;
  const deadlineValue = <span className={ROW_VALUE}>
    {schedule.deadline
      ? <><span className="truncate">{deadlineChipDate(schedule.deadline.localCivil)}</span>{countdown && <Badge variant={COUNTDOWN_BADGE[countdown.tone]} data-tone={countdown.tone} className="normal-case tracking-normal">{countdown.short}</Badge>}</>
      : <span className="text-foreground-secondary">{editable ? "Set deadline" : "Not set"}</span>}
  </span>;
  const teamValue = <span className={ROW_VALUE}>
    {people.length
      ? <><AvatarStack decorative fullLimit people={people.map((member) => ({ id: member.userId, name: member.name || member.email, inactive: !member.active }))} personNoun="team member" emptyLabel="Nobody assigned" /><span className="truncate">{people.map(firstName).join(", ")}</span></>
      : <span className="text-foreground-secondary">{editable ? "Add team" : "Nobody assigned"}</span>}
  </span>;

  return <>
    <h3 className={GROUP_LABEL}>Status</h3>
    <div className={GROUP} data-testid="project-info-status">
      <StatusRow id="stage" name="Stage" label={`Stage: ${currentLabel}`} offered={stage.canMove} rowRef={(element) => { rowRef("stage")(element); assign(stageRowRef, element); }} onPush={() => onPush("stage")} value={stageValue} />
      <StatusRow id="deadline" name="Deadline" label={schedule.deadline ? `Deadline: ${deadlineChipDate(schedule.deadline.localCivil)}` : editable ? "Deadline: set deadline" : "Deadline: not set"} offered={editable} rowRef={(element) => { rowRef("deadline")(element); assign(deadlineSectionRef, element); }} onPush={() => onPush("deadline")} value={deadlineValue} />
      <StatusRow id="team" name="Team" label={people.length ? `Team: ${people.map((member) => member.name || member.email).join(", ")}` : "Team: nobody assigned"} offered={editable} rowRef={rowRef("team")} onPush={() => onPush("team")} value={teamValue} />
      {overlays && <VideoReviewGate projectId={project.id} role={overlays.role}><OverlaysRow projectId={project.id} role={overlays.role} offered={overlays.canEdit && !archived} rowRef={(element) => { rowRef("overlays")(element); assign(overlaysSectionRef, element); }} onPush={() => onPush("overlays")} /></VideoReviewGate>}
    </div>
    {(latch === "deadline" || latch === "stage") && <p role="status" className={cn(ARCHIVED_HEADER_NOTICE_CLASS, "px-[calc(var(--space-4)+var(--space-1))] pt-[var(--space-2)]")}>Read-only while archived. Restore the project before changing it.</p>}
    {notes && <>
      <h3 className={GROUP_LABEL}>Production notes</h3>
      <p className={NOTES} data-testid="project-info-notes-text">{notes}</p>
    </>}
    <h3 className={GROUP_LABEL}>Client and shoot</h3>
    <div className={GROUP}>
      <StaticRow term="Agency" value={project.agencyName?.trim() || "—"} />
      <StaticRow term="Agent" value={project.agentName?.trim() || "—"} />
      <StaticRow term="Shoot" value={shoot} />
    </div>
    {dropbox && <>
      <h3 className={GROUP_LABEL}>Files</h3>
      <div className={GROUP}>
        <Button ref={rowRef("dropbox")} type="button" variant="ghost" className={ROW_BUTTON} data-testid="project-info-dropbox-row" aria-label={`Dropbox: ${status.label}`} onClick={() => onPush("dropbox")}>
          <span className={ROW_TERM}>Dropbox</span>
          <span className={ROW_VALUE}><Badge variant={DROPBOX_BADGE[status.tone]} data-testid="project-info-dropbox-status" className="normal-case tracking-normal">{status.label}</Badge></span>
          <ChevronRightIcon aria-hidden="true" className={ROW_CHEVRON} />
        </Button>
      </div>
    </>}
    <Actions project={project} activeTab={activeTab} details={details} onOpenWhiteboard={onOpenWhiteboard} />
  </>;
}

function assign<T>(ref: Ref<T> | undefined, value: T) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T }).current = value;
}

function StatusRow({ id, name, label, offered, rowRef, onPush, value, termClassName }: { id: string; name: string; label: string; offered: boolean; rowRef: (element: HTMLElement | null) => void; onPush: () => void; value: ReactNode; termClassName?: string }) {
  const term = <span className={cn(ROW_TERM, termClassName)}>{name}</span>;
  if (!offered) {
    return <div ref={rowRef} tabIndex={-1} role="group" aria-label={label} className={ROW_STATIC} data-header-value={id}>
      {term}{value}<span aria-hidden="true" className="w-[18px] shrink-0" />
    </div>;
  }
  return <Button ref={rowRef} type="button" variant="ghost" className={ROW_BUTTON} aria-label={label} data-testid={`project-info-${id}-row`} onClick={onPush}>
    {term}{value}<ChevronRightIcon aria-hidden="true" className={ROW_CHEVRON} />
  </Button>;
}

function StaticRow({ term, value }: { term: string; value: ReactNode }) {
  return <div className={ROW}>
    <span className={ROW_TERM}>{term}</span>
    <span className={cn(ROW_VALUE, "pe-[22px]")}><span className="truncate">{value}</span></span>
  </div>;
}

/**
 * #870: the Social overlays row and view exist only while the Video review gate is open (its routes answer 404 when it is closed),
 * as the desktop section. Its own component, so the gate query runs only for roles that can see Social overlays.
 */
function VideoReviewGate({ projectId, role, children }: { projectId: string; role: Role; children: ReactNode }) {
  return useVideoReviewQuery(projectId, true, role).data?.open === true ? children : null;
}

/**
 * #870 / owner decision: Social overlays as the Status group's last row (behind `VideoReviewGate`), the offered overlays as its value. It pushes a view holding the picker; read-only, it is a plain row. The term takes its
 * own width: "Social overlays" does not fit the 92px term column.
 */
function OverlaysRow({ projectId, role, offered, rowRef, onPush }: { projectId: string; role: Role; offered: boolean; rowRef: (element: HTMLElement | null) => void; onPush: () => void }) {
  const data = useProjectSocialOverlaysQuery(projectId, true, role).data;
  // What the picker's own trigger reads: the chosen overlays (else "Default overlay") where it edits, what applies (else "None") read-only.
  const names = !data ? null
    : offered ? data.selected.filter((choice) => choice.archivedAt === null).map((choice) => choice.name).join(", ") || "Default overlay"
    : data.resolved.map((overlay) => overlay.name).join(", ") || "None";
  const value = <span className={ROW_VALUE}><span className="truncate" data-testid="project-info-overlays-value">{names ?? ""}</span></span>;
  return <StatusRow id="overlays" name="Social overlays" termClassName="w-auto whitespace-nowrap" label={names ? `Social overlays: ${names}` : "Social overlays"} offered={offered} rowRef={rowRef} onPush={onPush} value={value} />;
}

/** `.acts`: Open whiteboard across the top, then Edit project details (or Restore or delete, #455), Copy link, Calendar, Timeline. */
function Actions({ project, activeTab, details, onOpenWhiteboard }: { project: ProjectDetail; activeTab: WorkspaceTab; details: { href: string; label: string } | null; onOpenWhiteboard?: () => void }) {
  const { copy } = useCopyProjectLink(project.id, activeTab);
  const destinations = useShowInDestinations(project);
  const reasons = destinations ? [destinations.calendar, destinations.timeline].filter((item): item is Extract<ShowInDestination, { available: false }> => !item.available).map((item) => item.reason) : [];
  return <div className="grid grid-cols-2 gap-[var(--space-2)] px-[var(--space-4)] pt-[var(--space-5)] pb-[var(--space-2)]" data-testid="project-info-actions">
    {onOpenWhiteboard && <Button type="button" variant="outline" size="header" className={cn(ACTION, "col-span-2")} data-testid="project-info-whiteboard" onClick={onOpenWhiteboard}><PresentationIcon aria-hidden="true" />Open whiteboard</Button>}
    {details && <InternalLink to={details.href} className={ACTION} data-testid="project-info-details"><PencilIcon aria-hidden="true" />{details.label}</InternalLink>}
    <Button type="button" variant="outline" size="header" className={ACTION} data-testid="project-info-copy-link" onClick={copy}><LinkIcon aria-hidden="true" />Copy link</Button>
    {destinations && <>
      <ShowInAction label="Calendar" name="Show in Calendar" icon={<CalendarDaysIcon aria-hidden="true" />} destination={destinations.calendar} />
      <ShowInAction label="Timeline" name="Show in Timeline" icon={<ChartGanttIcon aria-hidden="true" />} destination={destinations.timeline} />
    </>}
    {reasons.length > 0 && <p className="col-span-2 m-0 [font:var(--type-eyebrow)] text-foreground-secondary">{[...new Set(reasons)].join(" ")}</p>}
  </div>;
}

function ShowInAction({ label, name, icon, destination }: { label: string; name: string; icon: ReactNode; destination: ShowInDestination }) {
  const testId = `project-info-${label.toLowerCase()}`;
  if (!destination.available) return <Button type="button" variant="outline" size="header" disabled className={ACTION} aria-label={name} data-testid={testId}>{icon}{label}</Button>;
  return <InternalLink to={destination.href} className={ACTION} aria-label={name} data-testid={testId}>{icon}{label}</InternalLink>;
}

/**
 * M4 — "Move this project to": the active stages as 52px radio rows (`reui/radio-group`). A tap or Space chooses and saves straight
 * away, as the select does; the arrow keys only move focus here (a radio group would otherwise choose, and save, on every arrow).
 * Back to Project info only once the move is saved.
 */
function StageView({ stage, onSaved }: { stage: ProjectInfoDrawerProps["stage"]; onSaved: () => void }) {
  // True from an arrow key's capture until the next task, so the focus move it causes is not taken as a choice.
  const arrowing = useRef(false);
  const arrowingReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(arrowingReset.current), []);
  const choices = stage.stages.filter((item) => item.active || item.key === stage.currentStageKey);
  async function choose(next: ProjectDetail["stageKey"]) {
    const result = await stage.onMove(next);
    if (result === "saved") onSaved();
  }
  return <>
    <h3 className={GROUP_LABEL} id="project-info-stage-label">Move this project to</h3>
    <RadioGroup
      aria-labelledby="project-info-stage-label"
      value={stage.currentStageKey}
      disabled={stage.pending}
      className={cn(GROUP, "gap-0")}
      data-testid="project-info-stage-options"
      onKeyDownCapture={(event) => {
        if (!event.key.startsWith("Arrow")) return;
        arrowing.current = true;
        clearTimeout(arrowingReset.current);
        arrowingReset.current = setTimeout(() => { arrowing.current = false; }, 0);
      }}
      onValueChange={(next, details) => {
        if (arrowing.current) { details.cancel(); return; }
        if (next === stage.currentStageKey || stage.pending) return;
        const target = stage.stages.find((item) => item.key === next);
        if (!target?.active) return;
        void choose(next as ProjectDetail["stageKey"]);
      }}
    >
      {choices.map((item) => <RadioGroupItem
        key={item.key}
        value={item.key}
        disabled={!item.active}
        data-testid={`project-info-stage-${item.key}`}
        className={cn(ROW, "aspect-auto size-auto rounded-none border-0 bg-transparent data-checked:border-0 data-checked:bg-transparent data-checked:text-foreground disabled:opacity-60")}
      >
        <span className="flex min-w-0 items-center gap-[calc(var(--space-2)+2px)]"><StageDot stageKey={item.key} /><span className="truncate">{item.label}</span></span>
        {/* `.radio`: a 22px ring (no token), filled at its centre when chosen. */}
        <span aria-hidden="true" className="ms-auto grid size-[22px] shrink-0 place-items-center rounded-full border-[length:var(--border-width-mid)] border-[var(--border-hover)] group-data-checked/radio-group-item:border-foreground after:size-2.5 after:rounded-full after:bg-transparent group-data-checked/radio-group-item:after:bg-foreground" />
      </RadioGroupItem>)}
    </RadioGroup>
    <p className={QUIET}>{stage.disabledReason ?? "Choosing a stage saves it straight away."}</p>
  </>;
}
