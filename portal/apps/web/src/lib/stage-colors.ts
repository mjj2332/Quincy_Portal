/**
 * The single source of the six stage → colour-token mappings, extracted from
 * `components/atoms.tsx`'s own (previously unexported) `stageColors` map (#220).
 *
 * This is its own module, not exported straight from `atoms.tsx`, for a reason recorded at
 * `harness/reui-scheduling/fixtures.ts`'s own header before this file existed: `atoms.tsx` imports
 * `lib/stages.tsx`, which pulls in React hooks, the API client and `useCapabilities` — a value
 * import of `atoms.tsx` from a no-DOM, no-React module (`fixtures.ts`, and now
 * `lib/production-gantt-adapter.ts`) would drag that whole runtime chain along with it. This module
 * needs only the SHAPE of `ProjectStageKey`, not any runtime behaviour attached to it, so the
 * import below is `import type` — TypeScript erases a type-only import at compile time, so this
 * file carries zero runtime dependencies regardless of what `./stages` itself imports. A plain
 * value import here would silently reintroduce the exact problem #219 recorded; that is why the
 * type-only form is load-bearing, not a style preference.
 */
import type { ProjectStageKey } from "./stages";

export const stageColors: Record<ProjectStageKey, string> = {
  awaiting_raw: "var(--greige-400)",
  raw_review: "var(--signal-caution)",
  editing_autohdr: "var(--signal-info)",
  editing: "var(--signal-info)",
  edited_review: "var(--signal-caution)",
  delivered: "var(--signal-positive)",
};

/** The one shared `?? stageColors.awaiting_raw` fallback every consumer of `stageColors` uses for
 * an unrecognised/absent stage key, so the fallback value can never drift between call sites. */
export function stageColorFor(stageKey: ProjectStageKey | null | undefined): string {
  return (stageKey !== null && stageKey !== undefined ? stageColors[stageKey] : undefined) ?? stageColors.awaiting_raw;
}

/** A stage's secondary visual cue beside its colour, or `null` for a plain solid swatch/bar. */
export type StagePattern = "hatch";

/**
 * #257: Raw review and Edited review deliberately share `var(--signal-caution)` (owner decision —
 * both are "a review is waiting"), so colour alone cannot tell them apart. Edited review carries a
 * diagonal hatch as the second cue; every other stage is solid. Same key handling as
 * `stageColorFor`: an unknown or absent key is the fallback stage's pattern (none).
 */
export function stagePatternFor(stageKey: ProjectStageKey | null | undefined): StagePattern | null {
  return stageKey === "edited_review" ? "hatch" : null;
}

/**
 * #257: the hatch itself — a `background-image`-only Tailwind arbitrary class, so it layers over
 * whatever tint the bar shell or swatch already paints (`background-color` is untouched). Modelled
 * on the Gantt's own off-day hatch (`gantt-view.tsx`): 135° stripes 2px wide every 6px, drawn from
 * the element's `--gantt-event-color` at 30% so they read clearly without competing with the 40% progress fill, while a bar's title stays
 * legible over them. `data-completed:bg-none` drops it on a completed bar, which stays neutral
 * (`gantt-bar.tsx`'s own completed treatment), and `data-milestone:bg-none` on a zero-length bar,
 * whose transparent shell would otherwise paint stripes behind the milestone diamond. No colour literal (gantt-skin guard Detector 3), and
 * kept here in TS rather than CSS because `--gantt-event-color` is set inline by the Gantt, not
 * defined in `styles/` (the design-system guard would read it as a phantom token).
 */
export const STAGE_HATCH_CLASS =
  "bg-[repeating-linear-gradient(135deg,transparent,transparent_4px,color-mix(in_oklab,var(--gantt-event-color)_30%,transparent)_4px,color-mix(in_oklab,var(--gantt-event-color)_30%,transparent)_6px)] data-completed:bg-none data-milestone:bg-none";
