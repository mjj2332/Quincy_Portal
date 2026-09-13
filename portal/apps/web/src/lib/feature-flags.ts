/**
 * Build-time feature flags — #111.
 *
 * ## Why a build-time flag, and why not the Kanban's mechanism
 *
 * #80 shipped the replacement Board behind `view=kanban2` and #83 cut over. That precedent reads
 * like the one to copy here, and it is not transferable: `kanban2` was a DASHBOARD VIEW VALUE on a
 * closed URL grammar, and #83 retired it so completely that `staff-routes-dashboard-facet.test.ts`
 * and `App.dom.test.tsx` now both ASSERT it resolves to not-found. A rail is app-wide chrome, not
 * a dashboard view, so it has no URL to hang off — and #83's cleanup means adding one back would
 * fight two existing tests.
 *
 * `docs/lessons.md:1689` records what that flag cost: it leaked `kanban2` into a user-visible
 * `aria-label`. Hence the rule below, and the test that enforces it.
 *
 * ## The contract
 *
 * Strict equality against `"1"`. Not truthiness, not `Boolean(value)`, not `!== "0"` — a Vite
 * `import.meta.env` value is a string, so `"false"`, `"0"` and `"off"` are all truthy, and a flag
 * that turns ON when someone writes `VITE_QUINCY_NAV_RAIL=false` is worse than no flag.
 *
 * The env object is a PARAMETER, not read from `import.meta.env` inside these functions: that is
 * what makes them testable in the node suite, where `import.meta.env` is Vitest's own and not the
 * app's. The single real read happens in `lib/app-router.tsx`.
 *
 * **The flag name must never reach the DOM.** Not as a class, not as a `data-` attribute, not in
 * an `aria-label`. `components/quincy/NavigationRail.dom.test.tsx` asserts the rendered output
 * contains neither the flag name nor the string `nav-rail`, which is the lesson from #80 turned
 * into a gate.
 */

/** The shape this module needs from `import.meta.env`. Widened to `unknown` so a test can pass
 *  the wrong type and get the strict answer rather than a crash. */
export type FeatureFlagEnv = Record<string, unknown>;

export const NAVIGATION_RAIL_FLAG = "VITE_QUINCY_NAV_RAIL";

/** True only when the navigation rail flag is exactly the string `"1"`. */
export function navigationRailEnabled(env: FeatureFlagEnv | undefined): boolean {
  return env?.[NAVIGATION_RAIL_FLAG] === "1";
}
