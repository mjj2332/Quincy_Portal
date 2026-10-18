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
