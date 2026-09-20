/**
 * The staff navigation model — issue #111.
 *
 * One pure function turns a parsed route, the remembered Dashboard view and the caller's
 * capabilities into the navigation tree. It renders nothing, reads no storage and touches no
 * browser global, which is why its test is a node test: a stray `window` would throw there rather
 * than quietly pass.
 *
 * It existed before the rail did, and the Topbar consumed it before its own retirement. `viewFor`
 * — the switch that used to live in `app-router.tsx` and fold every route to a coarse screen
 * identity — retired into `activeSectionId` here, so the model shipped tested and in production
 * use rather than as scaffolding for a rail that was still behind a flag.
 *
 * ## Two kinds of "active", deliberately
 *
 * `activeSectionId` is the coarse screen identity the shell has always used (the Topbar before
 * the rail, the rail's account menu today): every Dashboard route, whatever its view, folds to
 * `"dashboard"`. Each item's own `active` is the fine-grained
 * one the rail needs, and it follows the **resolved view**, not the pathname — a bare `/` carries
 * no view, but the remembered preference resolves to one, so the rail marks that child active.
 *
 * ## Archive scope's own input, since #119
 *
 * Archive scope is private screen state, not part of `StaffRoute` (#111 deliberately kept
 * cross-screen plumbing out of the route). The Dashboard instead publishes the view it is
 * ACTUALLY rendering (`lib/dashboard-view-store.ts`), and this model treats that publication as
 * authoritative — see `resolvedDashboardView` below. The route/remembered derivation is only the
 * pre-mount fallback, for the frame before any Dashboard instance has published.
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
export type StaffNavigationIcon = "dashboard" | "list" | "kanban" | "gantt" | "calendar" | "admin";

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
   * The account menu's "Notification preferences" item is current on its own leaf only (#115):
   * `activeSectionId` folds the list at `/settings/notifications` and the preferences leaf to
   * one coarse section, which is right for the shell and wrong for `aria-current` on the item.
   */
  preferencesActive: boolean;
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
    // Both notification kinds fold to the same coarse section (#115) — the list at
    // `/settings/notifications` and its preferences leaf are one screen identity to the shell,
    // same as every Dashboard view folding to "dashboard".
    case "notifications": return "notifications";
    case "notification-preferences": return "notifications";
    default: return "not-found";
  }
}

/**
 * Which Dashboard view the current location actually shows. Once a Dashboard has published
 * (`publishedView !== null`), that publication IS the wanted view, taken as-is: it already reflects
 * what rendered (`screens/Dashboard.tsx`'s own `renderedView`), so coercing it a second time here
 * would just be a competing opinion. A published Calendar the capability check would have refused
 * needs no coercion either — `DASHBOARD_CHILDREN` below has already dropped the Calendar child, so
 * nothing in `children` matches it and no child is marked active, the same as a published `"none"`.
 *
 * Without a publication (the pre-mount fallback) an explicit view in the URL wins, both Calendar
 * spellings mean Calendar, and a bare `/` falls back to the remembered preference — coerced to
 * Kanban when the Calendar capability is absent, since the preference outlives a role change and
 * marking a child active the rail does not render would be worse than ignoring it.
 */
function resolvedDashboardView(route: StaffRoute, remembered: DashboardView, capabilities: StaffNavigationCapabilities, publishedView: DashboardView | "none" | null): DashboardView | "none" | null {
  if (route.kind !== "dashboard") return null;
  if (publishedView !== null) return publishedView;
  // An EXPLICIT Calendar location also gets coerced, not just a remembered preference. Without
  // this, a role that cannot view the Calendar arriving at a Calendar URL resolved to "calendar",
  // which the child filter then omits — so the rail rendered with NO active child at all for the
  // frame before the shell's redirect effect ran. The shell does replace the location with "/", so
  // this is transient rather than a way in; a nav tree with nothing marked active is still the
  // wrong thing to paint while it happens.
  const wanted = "calendar" in route ? "calendar" : "dashboardView" in route ? route.dashboardView : remembered;
  if (!CAPABILITY_GATED_VIEWS.has(wanted) || capabilities.viewProductionCalendar) return wanted;
  // Coerced. The fallback is the REMEMBERED view when that is itself viewable, not a hardcoded
  // Kanban — a Staff member who works in List should land on List, not be moved to a third view
  // they did not choose. Only a remembered Calendar or Gantt (which this role also cannot see)
  // falls through to Kanban.
  return CAPABILITY_GATED_VIEWS.has(remembered) ? "kanban" : remembered;
}

/** Dashboard children gated on the `viewProductionCalendar` capability — Gantt (#220) exactly like
 * Calendar (#111): both read the production schedule, so both hide from a role that cannot see it. */
const CAPABILITY_GATED_VIEWS = new Set<DashboardView>(["calendar", "gantt"]);

const DASHBOARD_CHILDREN: readonly { view: DashboardView; id: string; label: string; icon: StaffNavigationIcon }[] = [
  { view: "list", id: "dashboard-list", label: "List", icon: "list" },
  { view: "kanban", id: "dashboard-kanban", label: "Kanban", icon: "kanban" },
  { view: "gantt", id: "dashboard-gantt", label: "Gantt", icon: "gantt" },
  { view: "calendar", id: "dashboard-calendar", label: "Calendar", icon: "calendar" },
];

export function buildStaffNavigation(
  route: StaffRoute,
  rememberedDashboardView: DashboardView,
  capabilities: StaffNavigationCapabilities,
  publishedView: DashboardView | "none" | null = null,
): StaffNavigation {
  const activeSectionId = sectionFor(route);
  const view = resolvedDashboardView(route, rememberedDashboardView, capabilities, publishedView);

  // Held as a list, and mapped rather than spelled out, so a fourth view later is one entry here
  // and no change at all in whatever renders it.
  const children = DASHBOARD_CHILDREN
    .filter((child) => !CAPABILITY_GATED_VIEWS.has(child.view) || capabilities.viewProductionCalendar)
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
    preferencesActive: route.kind === "notification-preferences",
    expandedItemId: activeSectionId === "dashboard" ? "dashboard" : null,
  };
}

/** One crumb in the header breadcrumb (#112). The last crumb in a trail always has a `null` href. */
export type StaffBreadcrumbSegment = { label: string; href: string | null };

/**
 * Humanizes a section id that has no representation in the navigation model — `project`,
 * `create-project`, `edit-project`, `notifications`, `not-found` are none of them nav items (only
 * `dashboard` and `admin` are), so there is no model label to read for them. This derives one from
 * the id itself (`"create-project"` → `"Create project"`) rather than hardcoding a copy string per
 * kind, so a new `StaffNavigationSectionId` needs no matching entry here.
 */
function sectionLabel(sectionId: StaffNavigationSectionId): string {
  return sectionId.charAt(0).toUpperCase() + sectionId.slice(1).replace(/-/g, " ");
}

/**
 * The header breadcrumb — issue #112, AC7. Pure, and derived from the navigation model rather than
 * the route: it reads `buildStaffNavigation`'s own `active` flags instead of re-deriving them, so
 * it cannot disagree with the rail about what is active.
 *
 * Home(`/`) › the active section › its active child, where one exists. Every segment but the last
 * carries an href; the last gets `aria-current="page"` in the renderer and no link here (`href:
 * null`). A route with no item in the model at all (`project`, `create-project`, `edit-project`,
 * `notifications`, `not-found`) falls back to Home › the section's own label.
 */
export function buildStaffBreadcrumb(navigation: StaffNavigation): StaffBreadcrumbSegment[] {
  const home: StaffBreadcrumbSegment = { label: "Home", href: "/" };
  const activeItem = navigation.groups.flatMap((group) => group.items).find((item) => item.active);
  if (!activeItem) return [home, { label: sectionLabel(navigation.activeSectionId), href: null }];

  const activeChild = activeItem.children?.find((child) => child.active) ?? null;
  if (!activeChild) return [home, { label: activeItem.label, href: null }];

  return [home, { label: activeItem.label, href: activeItem.href }, { label: activeChild.label, href: null }];
}
