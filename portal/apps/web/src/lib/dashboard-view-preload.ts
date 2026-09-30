/**
 * #359: start downloading the remembered Dashboard view's chunk (Gantt or Calendar) at boot, in
 * parallel with the session check, instead of only once the Dashboard has rendered.
 *
 * Routes stay statically imported; this only warms the browser's module map. `Dashboard.tsx`'s own
 * `lazy(() => import(...))` calls resolve from the in-flight (or finished) preload. A failed preload
 * is cached by the module map, so the later `lazy()` fails the same way and `ViewLoadBoundary` shows
 * its notice exactly as before -- never auto-retry or reload here (lesson #292: recovery is
 * user-initiated).
 *
 * The role is unknown before the session resolves, so a Photographer with a stale remembered
 * Calendar downloads the chunk once; the Dashboard then repairs the preference.
 */
import { DASHBOARD_VIEW_KEY, readRememberedDashboardView } from "../screens/dashboard-helpers";
import { parseStaffLocation, type StaffRoute } from "./router";

export type PreloadableDashboardView = "gantt" | "calendar";

/** Which view chunk the route will render, or null when the route is not the Dashboard or the view is not lazy. */
export function dashboardViewChunkToPreload(route: StaffRoute, rememberedView: string): PreloadableDashboardView | null {
  if (route.kind !== "dashboard") return null;
  // The canonical Calendar facet URL carries `calendar`; an explicit `dashboardView` beats the preference.
  if ("calendar" in route) return "calendar";
  const view = "dashboardView" in route ? route.dashboardView : rememberedView;
  return view === "gantt" || view === "calendar" ? view : null;
}

export function preloadDashboardViewChunk(): void {
  try {
    const location = `${window.location.pathname}${window.location.search}`;
    const remembered = readRememberedDashboardView({ read: () => window.localStorage.getItem(DASHBOARD_VIEW_KEY) });
    const view = dashboardViewChunkToPreload(parseStaffLocation(location), remembered);
    // Literal `import()` sites, as in `Dashboard.tsx`: `harness-reachability.guard.test.ts` pins them.
    if (view === "gantt") void import("../components/ProductionGantt").catch(() => undefined);
    else if (view === "calendar") void import("../components/ProductionEventCalendar").catch(() => undefined);
  } catch {
    // Storage or location can be unavailable; a missed preload only costs the old (later) fetch.
  }
}
