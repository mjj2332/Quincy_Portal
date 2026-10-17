import { forwardRef, useId, type ReactNode, type Ref } from "react";
import { deadlineOffsetLabel, type ProjectDeadlineSchedule, type Role } from "@quincy/shared";
import { Badge } from "@/components/reui/badge";
import { useVideoReviewQuery, type ProjectDetail, type ProjectMember } from "../../lib/project-data";
import { deadlineCountdown } from "../../lib/deadline-due-in";
import { cn } from "../../lib/utils";
import { COUNTDOWN_BADGE, deadlineChipDate, deadlineTriggerText } from "../ProjectHeaderDeadline";
import { ProjectSocialOverlayPicker } from "../quincy/ProjectSocialOverlayPicker";
import { AutomaticDeadlineMark } from "../AutomaticDeadlineMark";
import { HEADER_TEXT_LINK } from "../project-header-popover";

/** `.qlabel`: the section label, 12px uppercase in the secondary ink. */
export const INFO_EYEBROW = "m-0 [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

/** `.link`: a section's one edit action ("Edit", "Change", "Manage"), sentence case, with the 44px target. */
export const INFO_LINK = cn(HEADER_TEXT_LINK, "normal-case tracking-normal cursor-pointer bg-transparent border-0 p-0 [font:var(--type-eyebrow)]");

const SECTION_FOCUS = "outline-none focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring -outline-offset-2 focus-visible:!-outline-offset-2";

export type InfoSectionId = "notes" | "client" | "deadline" | "team" | "social-overlays" | "dropbox";

/**
 * `.dsec`: one Project info section, a label with its one edit action at the right, then its facts. A labelled region that can take
 * focus (`tabIndex={-1}`), so Project info can open at it (the meta line's notes link, the "Dropbox blocked" chip) and a refusal
 * can return focus to it.
 */
export const InfoSection = forwardRef<HTMLElement, { id: InfoSectionId; label?: string; /** The region's name when it draws no label of its own. */ ariaLabel?: string; action?: ReactNode; children: ReactNode; className?: string }>(function InfoSection({ id, label, ariaLabel, action, children, className }, ref) {
  const labelId = useId();
  return <section
    ref={ref}
    tabIndex={-1}
    data-testid={`project-info-${id}`}
    {...(label ? { "aria-labelledby": labelId } : { "aria-label": ariaLabel })}
    className={cn("grid gap-[var(--space-3)] border-b border-border py-[var(--space-5)] last:border-b-0", SECTION_FOCUS, className)}
  >
    {label && <div className="flex min-h-[var(--space-5)] items-center justify-between gap-[var(--space-2)]">
      <h3 id={labelId} className={INFO_EYEBROW}>{label}</h3>
      {action}
    </div>}
    {children}
  </section>;
});

/** `.dl`: a two-column fact list, the term column at 110px (no token: the prototype's width, listed in the PR). */
export function InfoFacts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-[var(--space-3)] gap-y-[var(--space-2)] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">
    {rows.map(([term, value]) => <div key={term} className="contents">
      <dt className="text-foreground-secondary">{term}</dt>
      <dd className="m-0 min-w-0 text-foreground [overflow-wrap:anywhere]">{value}</dd>
    </div>)}
  </dl>;
}

const NONE = <><span aria-hidden="true">—</span><span className="sr-only">None</span></>;

/** Production notes: the notes in the serif reading face on the raised paper, or a quiet line when there are none. */
export function NotesFacts({ notes }: { notes: string | null | undefined }) {
  return notes?.trim()
    ? <p data-testid="project-info-notes-text" className="m-0 whitespace-pre-wrap bg-muted px-[var(--space-4)] py-[var(--space-3)] [font:var(--weight-regular)_var(--text-base)/var(--leading-relaxed)_var(--font-body-serif)] text-foreground">{notes}</p>
    : <p className="m-0 [font:var(--type-label)] text-foreground-secondary">No production notes.</p>;
}

/** The shoot as Client and shoot reads it, "Tue 16 Sep 2026", with the time window when there is one. */
export function shootLongText(project: Pick<ProjectDetail, "shootDate" | "timeWindow">): string | null {
  const value = project.shootDate;
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = `${deadlineTriggerText(`${value}T00:00`).split(" · ")[0]} ${value.slice(0, 4)}`;
  return project.timeWindow?.trim() ? `${date}, ${project.timeWindow.trim()}` : date;
}

export function ClientFacts({ project }: { project: ProjectDetail }) {
  return <InfoFacts rows={[
    ["Agency", project.agencyName?.trim() || NONE],
    ["Agent", project.agentName?.trim() || NONE],
    ["Shoot", shootLongText(project) ?? "Date pending"],
  ]} />;
}

/** The Deadline summary: the due date with its countdown Badge, and the advance reminders. */
export function DeadlineFacts({ schedule }: { schedule: ProjectDeadlineSchedule }) {
  if (!schedule.deadline) return <p className="m-0 [font:var(--type-label)] text-foreground-secondary">No deadline set.</p>;
  const countdown = deadlineCountdown(schedule, Date.now());
  const offsets = schedule.reminderOffsetsMinutes.filter((offset) => offset > 0);
  return <InfoFacts rows={[
    ["Due", <span className="inline-flex flex-wrap items-center gap-[var(--space-2)]">
      <time dateTime={schedule.deadline.instant}>{deadlineChipDate(schedule.deadline.localCivil)}</time>
      {countdown && <Badge variant={COUNTDOWN_BADGE[countdown.tone]} data-tone={countdown.tone} className="normal-case tracking-normal">{countdown.short}</Badge>}
      {schedule.source === "automatic" && <AutomaticDeadlineMark />}
    </span>],
    ["Reminders", offsets.length ? `${offsets.map(deadlineOffsetLabel).join(", ")} before` : "Only when due"],
  ]} />;
}

function names(members: ProjectMember[], role: ProjectMember["roleOnProject"]): ReactNode {
  const list = members.filter((member) => member.roleOnProject === role).map((member) => member.name || member.email);
  return list.length ? list.join(", ") : NONE;
}

/** The Team by role, Photographers then Editors. */
export function TeamFacts({ members }: { members: ProjectMember[] }) {
  return <InfoFacts rows={[["Photographers", names(members, "photographer")], ["Editors", names(members, "editor")]]} />;
}

/**
 * #870 / settled decision: the Social overlays picker, a section after Team, only while the Video review gate is open (its routes
 * answer 404 when it is closed). Its own component, so the gate query exists only for roles that can see it.
 */
export function SocialOverlaysSection({ sectionRef, projectId, role, canEdit, archived, onArchivedRefusal }: { sectionRef?: Ref<HTMLElement>; projectId: string; role: Role; canEdit: boolean; archived: boolean; onArchivedRefusal: () => void }) {
  const open = useVideoReviewQuery(projectId, true, role).data?.open === true;
  if (!open) return null;
  return <InfoSection ref={sectionRef} id="social-overlays" ariaLabel="Social overlays">
    <div data-testid="project-header-social-overlays"><ProjectSocialOverlayPicker key={projectId} projectId={projectId} role={role} canEdit={canEdit} archived={archived} onArchivedRefusal={onArchivedRefusal} /></div>
  </InfoSection>;
}
