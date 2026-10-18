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
 * Owner decision D2 (2026-10-18): a done Subtask is paper-100 with a solid `--text-muted` edge (3.36:1)
 * and a tick, distinct from Awaiting RAW's dashed greige-500. This scopes the vendor's "a done bar rests
 * as an outline" (#247) to callers other than the Dashboard Timeline; `gantt-skin.guard.test.ts` pins both.
 */
import type { doneCount, Lateness, PeopleTone, StageTone, SubtaskShape } from "./dashboard-appearance";

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

/** A quiet tint of the tone over the surface paper: Delivered's wash (frame 3a `--st-dlv-wash`), the same mix as `StageToneSwatch`. */
const WASH = "bg-[color-mix(in_oklab,var(--gantt-event-color)_16%,var(--bg-surface))]";

/**
 * A Project bar (shoot to Deadline). Solid stages fill with the tone under a paper-000 label (4.71:1 on
 * RAW review, where paper-050 measures 4.44:1); Awaiting RAW is the surface paper in a dashed edge;
 * Delivered a wash in a solid edge. The progress fill is hidden: the frame draws none, and the tree's
 * "N of M done" carries the count. An inverted-Deadline milestone keeps the vendor's own diamond.
 */
export function ganttProjectBarClass(appearance: GanttProjectAppearance, opts: { milestone: boolean }): string {
  if (opts.milestone) return "";
  const shared = ["[&>[data-slot=gantt-bar-progress]]:hidden", OWN_TONE_EDGE, SELECTED_RING];
  switch (appearance.tone.treatment) {
    case "solid":
      // Hover keeps the fill: a lighter step would take RAW review's label under 4.5:1.
      return [ownFill("bg-(--gantt-event-color)"), "text-[var(--paper-000)]", ...shared].join(" ");
    case "hollow-dashed":
      return [ownFill("bg-card", "bg-muted"), "border-dashed border-[length:var(--border-width-mid)] text-foreground", ...shared].join(" ");
    case "wash":
      return [ownFill(WASH), "border-[length:var(--border-width-mid)] text-foreground", ...shared].join(" ");
  }
}

/**
 * A Subtask bar. Open: the surface paper in a 1.5px edge of the parent Project's tone (dashed when
 * unassigned). Late: a 2px `--late` edge. Done: see the header (D2). A same-day Subtask (`diamond`)
 * sheds the shell's fill, edge and resize grips at Week and coarser so the content's diamond stands alone; at Day zoom
 * (`data-scale="day"` on the vendor's `gantt-view`) it is an ordinary bar again (D4).
 */
export function ganttTaskBarClass(appearance: GanttTaskAppearance): string {
  const parts = appearance.complete
    ? [
        ownFill("bg-muted"),
        "border-[length:var(--border-width-mid)] border-(--text-muted) border-solid text-foreground-secondary",
        "data-completed:border-(--text-muted) data-completed:data-selected:border-(--text-muted) data-completed:border-solid",
        SELECTED_RING,
      ]
    : [ownFill("bg-card", "bg-muted"), "border-[length:var(--border-width-mid)] border-(--gantt-event-color) text-foreground", OWN_TONE_EDGE, SELECTED_RING];
  // A done Subtask is never late, and its solid muted edge replaces the unassigned dash.
  if (!appearance.complete && appearance.people.kind === "unassigned") parts.push("border-dashed");
  if (appearance.lateness.late) parts.push("border-[length:var(--border-width-bold)] border-(--late)");
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
