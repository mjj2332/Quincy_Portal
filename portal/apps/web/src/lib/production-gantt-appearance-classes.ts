/**
 * #916 / #919: the Dashboard Timeline's bar classes, frame 3a (`design/prototypes/dashboard-views`,
 * "Dashboard views v3", `.pbar` / `.tbar`). Pure: an appearance (from `dashboard-appearance.ts`, via
 * the adapter) in, a class string out, set on the bar shell as `GanttEvent.className`.
 *
 * The vendored bar shell (`components/reui/gantt/gantt-bar.tsx`) tints its own states: a /20 wash at
 * rest, /30 on hover and when selected, a transparent fill with a muted edge when complete, and pairs
 * of those. tailwind-merge drops a vendor utility only when a later class supplies the SAME variant
 * chain, so every class here owns rest, `hover:`, `data-selected:`, `data-completed:` and the
 * `data-completed:` pairs (lesson "A consumer `eventClassName` must override every state the vendor
 * tints"). The colour is `--gantt-event-color`, which the adapter sets to the Stage tone.
 *
 * #920 (frame 3b, Colour by People): Project bars go neutral and each Subtask takes its People tone. The
 * neutral look is the sunken paper (paper-200, the frame's `.pbar.neutral` fill) inside a `--text-muted`
 * edge, which the adapter sets as `--gantt-event-color`: 3.57:1 on the surface paper, where the frame's
 * greige-300 measures 2.17:1 (the D2 reasoning). Stage stays the default, so a caller that passes no
 * `colourBy` renders exactly as before.
 *
 * Owner decision D2 (2026-10-18): a done Subtask is paper-100 with a solid `--text-muted` edge (3.36:1)
 * and a tick, distinct from Awaiting RAW's dashed greige-500. This scopes the vendor's "a done bar rests
 * as an outline" (#247) to callers other than the Dashboard Timeline; `gantt-skin.guard.test.ts` pins both.
 */
import type { doneCount, Lateness, PeopleTone, StageTone, SubtaskShape } from "./dashboard-appearance";
import type { ColourBy } from "./timeline-colour-by";

/** What a Project bar draws from. */
export type GanttProjectAppearance = {
  tone: StageTone;
  lateness: Lateness;
  /** "N of M done", or `null` for a Project with no Subtasks. */
  done: ReturnType<typeof doneCount>;
};

/** What a Subtask bar draws from. `tone` is the parent Project's. */
export type GanttTaskAppearance = {
  tone: StageTone;
  lateness: Lateness;
  shape: SubtaskShape;
  people: PeopleTone;
  complete: boolean;
};

/** Selected: a 2px ink ring outside a hairline of surface paper, so it reads on a solid fill too. */
const SELECTED_RING =
  "data-selected:ring-[length:var(--border-width-bold)] data-selected:ring-foreground data-selected:ring-offset-[length:var(--border-width-hair)] data-selected:ring-offset-card";

/** One fill in every state the vendor tints. `hoverFill` differs only where the frame draws a hover. */
function ownFill(fill: string, hoverFill: string = fill): string {
  return [
    fill,
    `hover:${hoverFill}`,
    `data-selected:${fill}`,
    `data-completed:${fill}`,
    `data-completed:hover:${hoverFill}`,
    `data-completed:data-selected:${fill}`,
  ].join(" ");
}

/** The edge colour in every state the vendor recolours it (rest comes from the vendor's own `border-(--gantt-event-color)`). */
const OWN_TONE_EDGE = "data-completed:border-(--gantt-event-color) data-completed:data-selected:border-(--gantt-event-color)";

/**
 * A quiet tint of the tone over the surface paper: Delivered's wash (frame 3a `--st-dlv-wash`). The one Stage wash mix
 * (`--stage-wash-mix`, `tokens/colors.css`), shared with `StageToneSwatch` and the Calendar's range chips.
 */
const WASH = "bg-[color-mix(in_srgb,var(--gantt-event-color)_var(--stage-wash-mix),var(--bg-surface))]";

/** Late (spec story 16): a 2px edge in the late colour, in every state the vendor recolours the edge. */
const LATE_EDGE = "border-[length:var(--border-width-bold)] border-late data-completed:border-late data-completed:data-selected:border-late";

/**
 * A Project's completion fill (spec #916: "The Project bar keeps its existing fill", completed Subtasks ÷ total, capped
 * below 100% until all are done; the adapter sets `progress`). The vendor paints it as the tone at 40% over the bar, which
 * vanishes on a solid tone, so the class repaints the vendor's fill layer: a deeper step of the tone under a solid bar's
 * label, a wash of the tone over a paper or washed bar. It owns the completed state too (the vendor clears the fill
 * there), so a Project whose Subtasks are all done reads full.
 */
function progressFill(fill: string): string {
  return `[&>[data-slot=gantt-bar-progress]]:${fill} data-completed:[&>[data-slot=gantt-bar-progress]]:${fill}`;
}
const PROGRESS_ON_SOLID = progressFill("bg-[color-mix(in_srgb,var(--gantt-event-color)_70%,var(--text-primary))]");
const PROGRESS_ON_PAPER = progressFill("bg-[color-mix(in_srgb,var(--gantt-event-color)_var(--stage-wash-mix),transparent)]");

/** Frame 3b's neutral fill: a People-mode Project bar and a shared Subtask (`.pbar.neutral`). */
const NEUTRAL_FILL = "bg-surface-sunken";

/**
 * A Project bar (shoot to Deadline). Solid stages fill with the tone under the on-tone label (4.71:1 on RAW review);
 * Awaiting RAW is the surface paper in a dashed edge; Delivered a wash in a solid edge. The completion fill shows how
 * many Subtasks are done (`progressFill`); a late Project takes the late edge in either Colour by. The label sits
 * above the fill (`ProductionGanttBarContent.tsx`). An inverted-Deadline milestone keeps the vendor's own diamond.
 */
export function ganttProjectBarClass(appearance: GanttProjectAppearance, opts: { milestone: boolean; colourBy?: ColourBy }): string {
  if (opts.milestone) return "";
  const shared = [OWN_TONE_EDGE, SELECTED_RING];
  const late = appearance.lateness.late ? LATE_EDGE : "";
  // Frame 3b `.pbar.neutral`: every Project the same quiet bar, so the Subtasks' people colours lead.
  if (opts.colourBy === "people") return [ownFill(NEUTRAL_FILL), "border-[length:var(--border-width-hair)] text-foreground", PROGRESS_ON_PAPER, ...shared, late].filter(Boolean).join(" ");
  const look = (() => {
    switch (appearance.tone.treatment) {
      case "solid":
        // Hover keeps the fill: a lighter step would take RAW review's label under 4.5:1.
        return [ownFill("bg-(--gantt-event-color)"), "text-on-tone", PROGRESS_ON_SOLID];
      case "hollow-dashed":
        return [ownFill("bg-card", "bg-muted"), "border-dashed border-[length:var(--border-width-mid)] text-foreground", PROGRESS_ON_PAPER];
      case "wash":
        return [ownFill(WASH), "border-[length:var(--border-width-mid)] text-foreground", PROGRESS_ON_PAPER];
    }
  })();
  return [...look, ...shared, late].filter(Boolean).join(" ");
}

/**
 * An open Subtask's fill and text. Stage: the surface paper (the edge carries the tone), hover stepping
 * to paper-100. People (frame 3b): one assignee's colour, solid (`.tbar.solid`) under paper text, which
 * (`--text-on-tone`) clears 5.9:1 on every `--people-N` and so keeps its fill on hover; a shared Subtask neutral; an
 * unassigned one the surface paper in a dashed edge (`.tbar.unas`).
 */
function openTaskLook(people: PeopleTone, colourBy: ColourBy): string {
  if (colourBy === "people" && people.kind === "person") return [ownFill("bg-(--gantt-event-color)"), "text-on-tone"].join(" ");
  if (colourBy === "people" && people.kind === "shared") return [ownFill(NEUTRAL_FILL), "text-foreground"].join(" ");
  return [ownFill("bg-card", "bg-muted"), "text-foreground"].join(" ");
}

/**
 * A Subtask bar. Open: the surface paper in a 1.5px edge of the parent Project's tone (dashed when
 * unassigned); in Colour by People, see `openTaskLook`, the edge in the bar's People colour. Late: a 2px
 * late edge. Done: see the header (D2), in either mode. A same-day Subtask (`diamond`)
 * sheds the shell's fill, edge and resize grips at Week and coarser so the content's diamond stands alone; at Day zoom
 * (`data-scale="day"` on the vendor's `gantt-view`) it is an ordinary bar again (D4).
 */
export function ganttTaskBarClass(appearance: GanttTaskAppearance, opts: { colourBy?: ColourBy } = {}): string {
  const parts = appearance.complete
    ? [
        ownFill("bg-muted"),
        "border-[length:var(--border-width-mid)] border-(--text-muted) border-solid text-foreground-secondary",
        "data-completed:border-(--text-muted) data-completed:data-selected:border-(--text-muted) data-completed:border-solid",
        SELECTED_RING,
      ]
    : [openTaskLook(appearance.people, opts.colourBy ?? "stage"), "border-[length:var(--border-width-mid)] border-(--gantt-event-color)", OWN_TONE_EDGE, SELECTED_RING];
  // A done Subtask is never late, and its solid muted edge replaces the unassigned dash.
  if (!appearance.complete && appearance.people.kind === "unassigned") parts.push("border-dashed");
  if (appearance.lateness.late) parts.push(LATE_EDGE);
  if (appearance.shape === "diamond") {
    // `!`: the vendor's state tints reach 0,3,0 (`data-completed:data-selected:`), and a scoped variant
    // cannot outrank all of them by order. Only this scoped look takes the important flag.
    parts.push(
      "not-in-data-[scale=day]:bg-transparent! not-in-data-[scale=day]:border-0! not-in-data-[scale=day]:ring-0! not-in-data-[scale=day]:overflow-visible",
      // D4: drag kept, resize grips hidden (the range stays editable in the Due cell and by keyboard).
      "not-in-data-[scale=day]:[&_[data-slot=gantt-resize-handle]]:hidden",
    );
  }
  return parts.join(" ");
}
