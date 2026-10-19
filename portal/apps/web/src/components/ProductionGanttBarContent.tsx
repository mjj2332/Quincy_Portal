import type { StagePresentationKey } from "@quincy/shared";
import { CheckIcon } from "lucide-react";
import { lateLabel, type PeopleTone } from "../lib/dashboard-appearance";
import type { ProductionGanttRowData } from "../lib/production-gantt-adapter";
import { peopleProjectSpanLabel } from "../lib/timeline-colour-by";
import { cn } from "../lib/utils";
import { PersonToneAvatar } from "./ProductionGanttColourBy";
import { AvatarStack } from "./quincy/AvatarStack";
import { LateChip } from "./quincy/LateChip";

/**
 * #916 / #919: what the Dashboard Timeline draws inside and beside each bar, frame 3a
 * (`design/prototypes/dashboard-views`, "Dashboard views v3", `.pbar` / `.tbar` / `.dia` / `.chipbad`).
 * The bar's fill, edge and states are its class (`production-gantt-appearance-classes.ts`); this is
 * the content: a Project bar's Stage label (a tick once Delivered), a Subtask's title (a tick once
 * done), a same-day Subtask's diamond, and the late chip beside a late bar.
 *
 * Every bar gets content from here, never a fallthrough to the vendor's default: `renderEvent` is
 * gated on its PRESENCE, so the vendor's own title, milestone diamond and done tick are already
 * suppressed for every bar (lesson "A render-override prop gated on its own PRESENCE, not its
 * per-call return value, is global even when you only meant it for one case"). The frame draws no
 * time label in a bar; the bar's accessible name still carries the vendor's dated string.
 *
 * #920 (frame 3b, Colour by People, read from `data.colourBy` so content and class never disagree): a
 * Project bar is labelled shoot → Deadline ("Mon 14 → Fri 18") and shows no Delivered tick; every
 * Subtask bar prints who has it, so colour is never the only cue: one assignee's initials, or every
 * assignee's avatar on a shared Subtask. An unassigned Subtask prints nobody; its dashed edge says so.
 *
 * Plain inputs, not the vendor's render props: `ProductionGantt.tsx` is the only app file that may
 * import `components/reui/gantt` (`harness-reachability.guard.test.ts`), so it unpacks them.
 */

export type GanttBarContentInput = {
  data: ProductionGanttRowData | undefined;
  title: string;
  start: Date;
  end: Date;
  isSelected: boolean;
};

/** A title or label that gives way to the vendor's outside label when the bar is too narrow to hold it. */
const INSIDE_LABEL = "min-w-0 truncate group-data-[label-outside]/gantt-bar-group:hidden";

export function GanttDoneMark() {
  return <CheckIcon data-testid="gantt-done-mark" className="relative size-3.5 shrink-0" aria-hidden="true" />;
}

/**
 * Frame 3b `.bav`: who has a Subtask, inside its bar. One assignee: their initials in a ring, paper on
 * their solid colour, ink on the surface paper once done. Shared: every named assignee's avatar (and
 * "+N others" for any the viewer may not see). Decorative: the tree's People column names them.
 */
function GanttBarPeople({ people, assignees, hiddenCount, complete, hidden }: { people: PeopleTone; assignees: { id: string; name: string }[]; hiddenCount: number; complete: boolean; hidden: string | false }) {
  if (people.kind === "person") {
    return (
      <span
        aria-hidden="true"
        data-testid="gantt-bar-initials"
        className={cn(
          "relative inline-flex size-5.5 shrink-0 items-center justify-center rounded-full border-[length:var(--border-width-hair)] text-xs leading-none",
          complete ? "border-border bg-card text-foreground" : "border-on-tone/60 text-on-tone",
          hidden,
        )}
      >
        {people.initials}
      </span>
    );
  }
  if (people.kind === "shared") {
    return (
      <span data-testid="gantt-bar-avatars" className={cn("relative inline-flex shrink-0", hidden)}>
        <AvatarStack people={assignees} hiddenCount={hiddenCount} limit={Math.max(assignees.length, 1)} fullLimit decorative personNoun="Assignee" emptyLabel="Unassigned" size="bar" />
      </span>
    );
  }
  return null;
}

export function renderGanttBarContent(
  input: GanttBarContentInput,
  stageLabelFor: (key: StagePresentationKey) => string | undefined,
  /** #920: today's Sydney day key, so a People-mode Project label can say "today". */
  todayKey = "",
) {
  const { data, title, start, end, isSelected } = input;
  if (!data) return <span className={INSIDE_LABEL}>{title}</span>;

  if (data.kind === "project") {
    // A Subtask is always a positive range (ADR 0011), so only the inverted-Deadline Project bar
    // (`production-gantt-adapter.ts`) is ever a milestone. It keeps the vendor's own milestone look,
    // reproduced here because the vendor's is suppressed (see header). A Quincy test hook, not the
    // vendor's `data-slot` (guard F).
    if (start.getTime() === end.getTime()) {
      return (
        <span
          aria-hidden="true"
          data-testid="gantt-milestone-marker"
          className={cn(
            "size-2.5 shrink-0 rotate-45 rounded-[var(--radius-xs)] border border-(--gantt-event-color) bg-(--gantt-event-color)/80",
            isSelected && "ring-ring/50 ring-2",
          )}
        />
      );
    }
    const { tone } = data.appearance;
    const people = data.colourBy === "people";
    const delivered = tone.stage === "delivered" && !people;
    return (
      <span
        data-testid="gantt-bar-face"
        data-treatment={tone.treatment}
        // `relative`: the label paints above the vendor's absolutely placed completion fill.
        className="relative flex min-w-0 items-center gap-1.5 text-sm"
        title={data.hollowStart ? "No shoot date" : undefined}
      >
        {data.hollowStart && (
          <span aria-hidden="true" data-testid="gantt-hollow-start" className="size-2.5 shrink-0 rounded-[var(--radius-xs)] border border-current bg-transparent" />
        )}
        {/* Frame 3a labels a Project bar with its Stage, frame 3b with its shoot → Deadline; the tree beside it carries the street. */}
        <span className={INSIDE_LABEL}>{people ? peopleProjectSpanLabel({ start, end, hollowStart: data.hollowStart, todayKey }) : (stageLabelFor(tone.stage) ?? title)}</span>
        {delivered && <GanttDoneMark />}
      </span>
    );
  }

  const { appearance } = data;
  return (
    <span
      data-testid="gantt-bar-face"
      data-treatment={appearance.tone.treatment}
      data-shape={appearance.shape}
      className="flex min-w-0 items-center gap-1.5 text-sm"
    >
      {appearance.shape === "diamond" && (
        // Frame 3a `.dia`: a same-day Subtask's diamond, centred on the shell, at Week and coarser
        // only. At Day zoom the shell draws an ordinary bar again (D4), so the diamond hides there.
        <span
          aria-hidden="true"
          data-testid="gantt-same-day-marker"
          className={cn(
            "absolute start-1/2 top-1/2 hidden size-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[var(--radius-xs)] bg-card not-in-data-[scale=day]:block",
            "border-[length:var(--border-width-bold)] border-(--gantt-event-color)",
            appearance.people.kind === "unassigned" && "border-dashed",
            appearance.complete && "border-solid border-(--text-muted) bg-muted",
            appearance.lateness.late && "border-late",
            isSelected && "ring-[length:var(--border-width-bold)] ring-foreground ring-offset-[length:var(--border-width-hair)] ring-offset-card",
          )}
        />
      )}
      {data.colourBy === "people" && (
        <GanttBarPeople
          people={appearance.people}
          assignees={data.dto.assignees}
          hiddenCount={data.dto.otherAssigneeCount}
          complete={appearance.complete}
          hidden={appearance.shape === "diamond" && "not-in-data-[scale=day]:hidden"}
        />
      )}
      <span className={cn(INSIDE_LABEL, appearance.shape === "diamond" && "not-in-data-[scale=day]:hidden")}>{title}</span>
      {appearance.complete && <GanttDoneMark />}
    </span>
  );
}

/**
 * Story 13 (#916): in Colour by People a same-day Subtask's diamond is edged in its person's colour, which two people can
 * share, so who has it prints beside the diamond: the sole assignee's initials on their colour, or every assignee's avatar
 * on a shared one. Beside, not inside: the diamond is too small for initials, and its shell sheds its fill at Week and
 * coarser. At Day zoom (D4) the diamond is an ordinary bar printing its own initials, so this copy steps aside. Unassigned
 * prints nobody; its dashed diamond says so.
 */
function diamondPeople(data: ProductionGanttRowData) {
  if (data.kind !== "task") return null;
  const { people } = data.appearance;
  if (data.colourBy !== "people" || data.appearance.shape !== "diamond" || people.kind === "unassigned") return null;
  return (
    <span data-testid="gantt-diamond-people" className="flex shrink-0 items-center in-data-[scale=day]:hidden">
      {people.kind === "person" ? (
        <PersonToneAvatar initials={people.initials} color={people.color} size="bar" />
      ) : (
        <AvatarStack people={data.dto.assignees} hiddenCount={data.dto.otherAssigneeCount} limit={Math.max(data.dto.assignees.length, 1)} fullLimit decorative personNoun="Assignee" emptyLabel="Unassigned" size="bar" />
      )}
    </span>
  );
}

/**
 * Frame 3a `.chipbad`: "2 days late" beside a late bar, after its outside title when it has one (the
 * vendor's `renderEventTrailing`). Drawn once per bar, on its last segment. Text, not colour alone:
 * the wording carries the meaning, and the late colour is 4.5:1 or better on the surface paper. A
 * People-mode diamond's people (`diamondPeople`) come first.
 */
export function renderGanttBarTrailing(data: ProductionGanttRowData | undefined, isLastSegment: boolean) {
  if (!data || !isLastSegment) return null;
  const label = lateLabel(data.appearance.lateness);
  const people = diamondPeople(data);
  const chip = label && <LateChip data-testid="gantt-late-chip">{label}</LateChip>;
  if (!people || !chip) return people ?? chip ?? null;
  return (
    <span className="flex items-center gap-1.5">
      {people}
      {chip}
    </span>
  );
}
