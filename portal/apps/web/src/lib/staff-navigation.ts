/**
 * The staff navigation model — issue #111.
 *
 * One pure function turns a parsed route, the remembered Dashboard view and the caller's
 * capabilities into the navigation tree. It renders nothing, reads no storage and touches no
 * browser global, which is why its test is a node test: a stray `window` would throw there rather
 * than quietly pass.
 *
 * It exists before any new chrome does, and the Topbar consumes it today. `viewFor` — the switch
 * that used to live in `app-router.tsx` and fold every route to a coarse screen identity — retires
 * into `activeSectionId` here, so the model ships tested and in production use rather than as
 * scaffolding for a rail that is still behind a flag.
 *
 * ## Two kinds of "active", deliberately
 *
 * `activeSectionId` is the coarse screen identity the Topbar has always used: every Dashboard
 * route, whatever its view, folds to `"dashboard"`. Each item's own `active` is the fine-grained
 * one the rail needs, and it follows the **resolved view**, not the pathname — a bare `/` carries
 * no view, but the remembered preference resolves to one, so the rail marks that child active.
 *
 * ## What is deliberately not an input
 *
 * Archive scope. The Dashboard forces List while viewing archived Projects, but that scope is
 * private screen state and is absent from `StaffRoute`. Threading it in would mean inventing
 * cross-screen state plumbing so that a test's wording could be literally true. Instead the
 * Dashboard navigates to an explicit List route when it forces List, and the model follows that
 * route — which it already does, because an explicit view always beats the remembered one. The
 * Dashboard's own DOM tests remain the proof that selecting Archived forces List.
 */
import { staffPathFor, type StaffRoute } from "./router";
import type { DashboardView } from "../screens/dashboard-helpers";

/** The coarse screen identity. Was `AppView`, and was computed by `viewFor` in `app-router.tsx`. */
export type StaffNavigationSectionId =
  | "dashboard"
  | "project"
  | "create-project"
  | "edit-project"
  | "admin"
  | "notifications"
  | "not-found";

/**
 * Every navigation item carries one of these. The collapsed rail in #112 shows nothing but the
 * icon, so an item without one would become unreachable — which is why this is a closed union the
 * renderer can exhaustively satisfy rather than a free-form string or a component reference.
 *
 * Note this is the opposite of the decision for notification rows, which deliberately have no type
 * icon. Different component, different constraint.
 */
export type StaffNavigationIcon = "dashboard" | "list" | "kanban" | "calendar" | "admin";

export type StaffNavigationItem = {
  id: string;
  label: string;
  href: string;
  icon: StaffNavigationIcon;
  active: boolean;
  children?: readonly StaffNavigationItem[];
};

export type StaffNavigationGroup = {
  id: string;
  label: string;
  items: readonly StaffNavigationItem[];
};

export type StaffNavigation = {
  groups: readonly StaffNavigationGroup[];
  activeSectionId: StaffNavigationSectionId;
  /**
   * The item whose children are showing, or `null`. Opens on a Dashboard route and closes
   * elsewhere — no toggle and no persistence, which is what guarantees there is no state in which
   * an active child hides inside a closed group.
   */
  expandedItemId: string | null;
};

export type StaffNavigationCapabilities = {
  adminBackend: boolean;
  viewProductionCalendar: boolean;
};

function sectionFor(route: StaffRoute): StaffNavigationSectionId {
  switch (route.kind) {
    case "dashboard": return "dashboard";
    case "create-project": return "create-project";
    case "project": return "project";
    case "edit-project": return "edit-project";
    case "admin": return "admin";
    case "notifications": return "notifications";
    default: return "not-found";
  }
}

/**
 * Which Dashboard view the current location actually shows. An explicit view in the URL wins; the
 * two Calendar spellings both mean Calendar; and a bare `/` falls back to the remembered
 * preference, coerced to Kanban when the Calendar capability is absent — the preference outlives a
 * role change, and marking a child active that the rail does not render would be worse than
 * ignoring it.
 */
function resolvedDashboardView(route: StaffRoute, remembered: DashboardView, capabilities: StaffNavigationCapabilities): DashboardView | null {
  if (route.kind !== "dashboard") return null;
  if ("calendar" in route) return "calendar";
  if ("dashboardView" in route) return route.dashboardView;
  return remembered === "calendar" && !capabilities.viewProductionCalendar ? "kanban" : remembered;
}

const DASHBOARD_CHILDREN: readonly { view: DashboardView; id: string; label: string; icon: StaffNavigationIcon }[] = [
  { view: "list", id: "dashboard-list", label: "List", icon: "list" },
  { view: "kanban", id: "dashboard-kanban", label: "Kanban", icon: "kanban" },
  { view: "calendar", id: "dashboard-calendar", label: "Calendar", icon: "calendar" },
];

export function buildStaffNavigation(
  route: StaffRoute,
  rememberedDashboardView: DashboardView,
  capabilities: StaffNavigationCapabilities,
): StaffNavigation {
  const activeSectionId = sectionFor(route);
  const view = resolvedDashboardView(route, rememberedDashboardView, capabilities);

  // Held as a list, and mapped rather than spelled out, so a fourth view later is one entry here
  // and no change at all in whatever renders it.
  const children = DASHBOARD_CHILDREN
    .filter((child) => child.view !== "calendar" || capabilities.viewProductionCalendar)
    .map<StaffNavigationItem>((child) => ({
      id: child.id,
      label: child.label,
      // `staffPathFor` owns the spelling of every one of these, including the bare Calendar intent
      // that #111 taught the parser to accept. Hard-coding the strings here would let the rail and
      // the router disagree about what a canonical URL looks like.
      href: staffPathFor({ kind: "dashboard", dashboardView: child.view }),
      icon: child.icon,
      active: view === child.view,
    }));

  const items: StaffNavigationItem[] = [
    {
      id: "dashboard",
      label: "Dashboard",
      href: staffPathFor({ kind: "dashboard" }),
      icon: "dashboard",
      active: activeSectionId === "dashboard",
      children,
    },
  ];
  if (capabilities.adminBackend) {
    items.push({ id: "admin", label: "Admin", href: staffPathFor({ kind: "admin" }), icon: "admin", active: activeSectionId === "admin" });
  }

  return {
    groups: [{ id: "primary", label: "Primary navigation", items }],
    activeSectionId,
    expandedItemId: activeSectionId === "dashboard" ? "dashboard" : null,
  };
}
