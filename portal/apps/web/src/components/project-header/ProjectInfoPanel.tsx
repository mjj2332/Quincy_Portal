import { useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react";
import { flushSync } from "react-dom";
import { PencilIcon, PresentationIcon } from "lucide-react";
import type { Role } from "@quincy/shared";
import { Badge } from "@/components/reui/badge";
import { Button, buttonVariants } from "@/components/reui/button";
import { InternalLink } from "../InternalLink";
import { DropboxDetails, dropboxStatus } from "../ProjectHeaderDropbox";
import { ProjectDeadlineControl } from "../ProjectDeadlineControl";
import { ProjectTeamCombobox } from "../ProjectTeamCombobox";
import { ARCHIVED_HEADER_NOTICE_CLASS } from "../archived-notice";
import type { ProjectDetail } from "../../lib/project-data";
import { cn } from "../../lib/utils";
import { ProjectInfoSheet } from "./ProjectInfoSheet";
import { ClientFacts, DeadlineFacts, INFO_LINK, InfoSection, NotesFacts, SocialOverlaysSection, TeamFacts } from "./info-sections";
import { projectDetailsAction } from "./header-parts";
import { openWhiteboardFromInfo } from "./whiteboard-opener";
import { DROPBOX_BADGE } from "./header-styles";
import type { ArchivedLatch } from "./StatusCluster";

/** Where Project info opens: at the top, or with one section in view (the meta line's notes link, the "Dropbox blocked" chip). */
export type InfoTarget = "notes" | "dropbox" | null;

const FOOTER_ACTION = buttonVariants({ variant: "outline", size: "header" });

export type ProjectInfoPanelProps = {
  open: boolean;
  target: InfoTarget;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
  project: ProjectDetail;
  place: string;
  archived: boolean;
  latch: ArchivedLatch;
  canEdit: boolean;
  canAdminBackend: boolean;
  latchArchived: (source: NonNullable<ArchivedLatch>, focusWasInside: boolean) => void;
  /** The Deadline section: where a Deadline refusal returns focus while Project info is open. */
  deadlineSectionRef: Ref<HTMLElement>;
  /** The Social overlays section: where its refusal returns focus while Project info is open. */
  overlaysSectionRef: Ref<HTMLElement>;
  /** #870: the Social overlays picker's role, when the person may see it (`viewVideo`). */
  overlays: { role: Role; canEdit: boolean } | null;
  /** The Dropbox details, when the person may sync (as the header's Dropbox control always was gated). */
  dropbox: null | {
    isSyncing: boolean;
    autohdrBlocked: boolean;
    onSyncDropbox: () => void | Promise<"archived" | void>;
    readOnlyRef: Ref<HTMLDivElement>;
  };
  onOpenWhiteboard?: () => void;
};

/**
 * #914 D2 — Project info's content: Production notes, Client and shoot, Deadline, Team, Social overlays (behind the Video review gate,
 * settled decision) and Dropbox, each with its one edit action at the right; Whiteboard and Edit project details in the footer.
 * "Change" (Deadline, in its stacked layout) and "Manage" (Team) draw their editors in place (settled decision: never reopen a
 * header popover under the scrim). Edit project details
 * reads "Restore or delete" for an archived Project's Admin (#455), as the ⋯ does.
 */
export function ProjectInfoPanel(props: ProjectInfoPanelProps) {
  const { project, archived, latch, canEdit } = props;
  const [managingTeam, setManagingTeam] = useState(false);
  const [changingDeadline, setChangingDeadline] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const deadlineFormRef = useRef<HTMLDivElement>(null);
  const focusAtDeadlineRequest = useRef(false);
  const notesRef = useRef<HTMLElement>(null);
  const dropboxRef = useRef<HTMLElement>(null);
  const manageRef = useRef<HTMLButtonElement>(null);
  const teamInputRef = useRef<HTMLInputElement>(null);
  const details = projectDetailsAction(project, { canEdit, archived, canAdminBackend: props.canAdminBackend });
  const editNotes = details && !archived ? details.href : null;
  const status = dropboxStatus(project, props.dropbox?.autohdrBlocked ?? false, archived);
  // Each opening starts with the Team as facts.
  useLayoutEffect(() => { if (!props.open) { setManagingTeam(false); setChangingDeadline(false); } }, [props.open]);
  // The read-only edge (archived, or latched by a refusal) puts the facts back, as the header's popovers close on it.
  useLayoutEffect(() => { if (archived || !canEdit) { setManagingTeam(false); setChangingDeadline(false); } }, [archived, canEdit]);

  const sectionFor = (target: InfoTarget): RefObject<HTMLElement | null> | null => target === "notes" ? notesRef : target === "dropbox" ? dropboxRef : null;
  const initialFocus = () => {
    const section = sectionFor(props.target)?.current ?? null;
    section?.scrollIntoView?.({ block: "start" });
    return section;
  };
  function manageTeam() {
    // Synchronously, so the search field is focused inside the press (iOS raises the keyboard only then; lessons, #879 3b).
    flushSync(() => setManagingTeam(true));
    teamInputRef.current?.focus();
  }
  function closeDeadlineForm() {
    // Apply, Cancel or Resume: the facts come back and focus returns to Change (Escape closes Project info, as from any section).
    // Unless the person has since moved to another control (a save can resolve late): a press that leaves focus on the popup
    // itself (Safari focuses no button on click) or on the form counts as still here.
    const active = document.activeElement;
    const movedAway = active instanceof HTMLElement && active !== document.body && !deadlineFormRef.current?.contains(active) && active.dataset.slot !== "sheet-content";
    flushSync(() => setChangingDeadline(false));
    if (!movedAway) changeRef.current?.focus();
  }
  function doneTeam() {
    flushSync(() => setManagingTeam(false));
    manageRef.current?.focus();
  }
  // The footer's button goes with the sheet: the board returns focus to the header's own Whiteboard button.
  const openWhiteboard = () => openWhiteboardFromInfo(props.onClose, props.onOpenWhiteboard);

  return <ProjectInfoSheet
    open={props.open}
    onClose={props.onClose}
    initialFocus={initialFocus}
    returnFocus={props.returnFocus}
    street={project.street}
    place={props.place}
    footer={<>
      {props.onOpenWhiteboard && <Button type="button" variant="outline" size="header" data-testid="project-info-whiteboard" onClick={openWhiteboard}><PresentationIcon aria-hidden="true" />Whiteboard</Button>}
      {details && <InternalLink to={details.href} className={cn(FOOTER_ACTION, "no-underline")} data-testid="project-info-details"><PencilIcon aria-hidden="true" />{details.label}</InternalLink>}
    </>}
  >
    <InfoSection ref={notesRef} id="notes" label="Production notes" action={editNotes && <InternalLink to={editNotes} className={INFO_LINK} aria-label="Edit production notes">Edit</InternalLink>}>
      <NotesFacts notes={project.productionNotes} />
    </InfoSection>
    <InfoSection id="client" label="Client and shoot"><ClientFacts project={project} /></InfoSection>
    <InfoSection ref={props.deadlineSectionRef} id="deadline" label="Deadline" action={canEdit && !archived && !changingDeadline
      && <Button ref={changeRef} type="button" variant="ghost" className={INFO_LINK} data-testid="project-info-deadline-change" aria-label="Change deadline" onClick={() => setChangingDeadline(true)}>Change</Button>}>
      {changingDeadline
        ? <div ref={deadlineFormRef} className="min-w-0">
          <ProjectDeadlineControl projectId={project.id} schedule={project.deadlineSchedule} canEdit={canEdit} layout="stacked" focusOnMount
            onClose={closeDeadlineForm}
            onRequestStart={() => { focusAtDeadlineRequest.current = Boolean(deadlineFormRef.current?.contains(document.activeElement)); }}
            onArchivedRefusal={() => props.latchArchived("deadline", focusAtDeadlineRequest.current)} />
        </div>
        : <DeadlineFacts schedule={project.deadlineSchedule} />}
      {latch === "deadline" && <p role="status" className={ARCHIVED_HEADER_NOTICE_CLASS}>Read-only while archived. Restore the project before changing the deadline.</p>}
    </InfoSection>
    <InfoSection id="team" label="Team" action={canEdit && !archived && (managingTeam
      ? <Button type="button" variant="ghost" className={INFO_LINK} data-testid="project-info-team-done" onClick={doneTeam}>Done</Button>
      : <Button ref={manageRef} type="button" variant="ghost" className={INFO_LINK} data-testid="project-info-team-manage" aria-label="Manage team" onClick={manageTeam}>Manage</Button>)}>
      {managingTeam
        ? <ProjectTeamCombobox presentation="inline" projectId={project.id} members={project.members} canEdit={canEdit} archived={archived} inputRef={teamInputRef} onArchivedRefusal={() => props.latchArchived("team", false)} />
        : <TeamFacts members={project.members} />}
    </InfoSection>
    {props.overlays && <SocialOverlaysSection sectionRef={props.overlaysSectionRef} projectId={project.id} role={props.overlays.role} canEdit={props.overlays.canEdit} archived={archived} onArchivedRefusal={() => props.latchArchived("social-overlays", false)} />}
    {props.dropbox && <InfoSection ref={dropboxRef} id="dropbox" label="Dropbox" action={<Badge variant={DROPBOX_BADGE[status.tone]} data-testid="project-info-dropbox-status" className="normal-case tracking-normal">{status.label}</Badge>}>
      <DropboxDetails project={project} isSyncing={props.dropbox.isSyncing} autohdrBlocked={props.dropbox.autohdrBlocked} onSyncDropbox={props.dropbox.onSyncDropbox} archived={archived} archivedNotice={latch === "dropbox"} readOnlyRef={props.dropbox.readOnlyRef} onArchivedRefusal={(inside) => props.latchArchived("dropbox", inside)} />
    </InfoSection>}
  </ProjectInfoSheet>;
}
