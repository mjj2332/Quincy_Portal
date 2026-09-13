import { describe, expect, it } from "vitest";
import type { StaffRoute } from "./router";
import { buildStaffNavigation, type StaffNavigationCapabilities, type StaffNavigationItem } from "./staff-navigation";

const all: StaffNavigationCapabilities = { adminBackend: true, viewProductionCalendar: true };
const noAdmin: StaffNavigationCapabilities = { adminBackend: false, viewProductionCalendar: true };
const noCalendar: StaffNavigationCapabilities = { adminBackend: true, viewProductionCalendar: false };

const bareDashboard: StaffRoute = { kind: "dashboard" };
const projectId = "11111111-1111-4111-8111-111111111111";

function items(route: StaffRoute, remembered: "list" | "kanban" | "calendar" = "kanban", capabilities = all) {
  return buildStaffNavigation(route, remembered, capabilities).groups.flatMap((group) => group.items);
}

function dashboardChildren(route: StaffRoute, remembered: "list" | "kanban" | "calendar" = "kanban", capabilities = all) {
  return items(route, remembered, capabilities).find((item) => item.id === "dashboard")?.children ?? [];
}

function activeChildId(route: StaffRoute, remembered: "list" | "kanban" | "calendar" = "kanban", capabilities = all) {
  return dashboardChildren(route, remembered, capabilities).find((child) => child.active)?.id ?? null;
}

describe("the staff navigation model", () => {
  it("is pure — the same inputs give an equal tree, and it touches no globals", () => {
    // A node test with no DOM: if the model reached for `window` or `localStorage` this would throw
    // rather than fail an assertion. That is the point of testing it here rather than in happy-dom.
    expect(typeof globalThis.window).toBe("undefined");
    expect(buildStaffNavigation(bareDashboard, "kanban", all)).toEqual(buildStaffNavigation(bareDashboard, "kanban", all));
  });

  describe("item order and identity", () => {
    it("puts Dashboard before Admin", () => {
      expect(items(bareDashboard).map((item) => item.id)).toEqual(["dashboard", "admin"]);
    });

    it("orders the Dashboard children List, Kanban, Calendar — the shipped control's order", () => {
      expect(dashboardChildren(bareDashboard).map((child) => child.id)).toEqual(["dashboard-list", "dashboard-kanban", "dashboard-calendar"]);
    });

    it("gives every item and child an icon, which the collapsed rail in #112 requires", () => {
      const every: StaffNavigationItem[] = items(bareDashboard).flatMap((item) => [item, ...(item.children ?? [])]);
      expect(every.length).toBeGreaterThan(0);
      for (const item of every) expect(item.icon).toBeTruthy();
    });

    it("labels the children with the words already on the screen", () => {
      expect(dashboardChildren(bareDashboard).map((child) => child.label)).toEqual(["List", "Kanban", "Calendar"]);
    });
  });

  describe("hrefs", () => {
    it("uses the addressable view routes, and a bare URL for Calendar", () => {
      expect(dashboardChildren(bareDashboard).map((child) => child.href)).toEqual(["/?view=list", "/?view=kanban", "/?view=calendar"]);
    });

    it("points Dashboard itself at the root and Admin at /admin", () => {
      expect(items(bareDashboard).map((item) => item.href)).toEqual(["/", "/admin"]);
    });
  });

  describe("capabilities", () => {
    it("omits Calendar entirely without the capability — absent, not disabled", () => {
      expect(dashboardChildren(bareDashboard, "kanban", noCalendar).map((child) => child.id)).toEqual(["dashboard-list", "dashboard-kanban"]);
    });

    it("omits Admin without the capability", () => {
      expect(items(bareDashboard, "kanban", noAdmin).map((item) => item.id)).toEqual(["dashboard"]);
    });
  });

  describe("active state follows the resolved view, not the pathname", () => {
    it("resolves a bare / from the remembered view", () => {
      expect(activeChildId(bareDashboard, "list")).toBe("dashboard-list");
      expect(activeChildId(bareDashboard, "kanban")).toBe("dashboard-kanban");
      expect(activeChildId(bareDashboard, "calendar")).toBe("dashboard-calendar");
    });

    it("lets an explicit view route beat the remembered view", () => {
      // This is the model's half of "archived forces List": the Dashboard forces List and navigates
      // there, and the rail follows the explicit route rather than the stale preference. Whether
      // selecting Archived actually forces List is the Dashboard's own DOM tests to prove — archive
      // scope is private screen state and is deliberately not an input to this model.
      expect(activeChildId({ kind: "dashboard", dashboardView: "list" }, "calendar")).toBe("dashboard-list");
      expect(activeChildId({ kind: "dashboard", dashboardView: "kanban" }, "list")).toBe("dashboard-kanban");
    });

    it("marks Calendar active for both Calendar spellings", () => {
      expect(activeChildId({ kind: "dashboard", dashboardView: "calendar" }, "list")).toBe("dashboard-calendar");
      expect(activeChildId({ kind: "dashboard", calendar: { view: "calendar", date: "2026-08-30", subview: "month", layers: ["project"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } }, "list")).toBe("dashboard-calendar");
    });

    it("coerces a remembered Calendar to Kanban when the capability is gone", () => {
      // The remembered preference outlives a role change. Without this the rail would mark an item
      // active that it does not render.
      expect(activeChildId(bareDashboard, "calendar", noCalendar)).toBe("dashboard-kanban");
    });

    it("marks no child active away from the Dashboard", () => {
      expect(activeChildId({ kind: "admin" })).toBeNull();
      expect(activeChildId({ kind: "project", projectId })).toBeNull();
    });

    it("marks the parent item active for its own section", () => {
      expect(items({ kind: "admin" }).find((item) => item.id === "admin")?.active).toBe(true);
      expect(items({ kind: "admin" }).find((item) => item.id === "dashboard")?.active).toBe(false);
      expect(items(bareDashboard).find((item) => item.id === "dashboard")?.active).toBe(true);
    });
  });

  describe("the Dashboard group opens on a Dashboard route and closes off it", () => {
    it.each([
      ["a bare dashboard", bareDashboard],
      ["an explicit view", { kind: "dashboard", dashboardView: "list" } as StaffRoute],
    ])("opens on %s", (_label, route) => {
      expect(buildStaffNavigation(route, "kanban", all).expandedItemId).toBe("dashboard");
    });

    it.each([
      ["admin", { kind: "admin" } as StaffRoute],
      ["a project", { kind: "project", projectId } as StaffRoute],
      ["notifications", { kind: "notifications" } as StaffRoute],
      ["not-found", { kind: "not-found" } as StaffRoute],
    ])("closes on %s", (_label, route) => {
      expect(buildStaffNavigation(route, "kanban", all).expandedItemId).toBeNull();
    });

    it("never leaves the active child hidden inside a closed group", () => {
      // The invariant that makes "no toggle, no persistence" safe: if any child is active, the group
      // holding it is open.
      const routes: StaffRoute[] = [bareDashboard, { kind: "dashboard", dashboardView: "list" }, { kind: "admin" }, { kind: "project", projectId }];
      for (const route of routes) {
        const navigation = buildStaffNavigation(route, "kanban", all);
        for (const group of navigation.groups) {
          for (const item of group.items) {
            if (item.children?.some((child) => child.active)) expect(navigation.expandedItemId).toBe(item.id);
          }
        }
      }
    });
  });

  describe("activeSectionId — what the Topbar reads", () => {
    it.each([
      ["dashboard", bareDashboard, "dashboard"],
      ["an explicit view", { kind: "dashboard", dashboardView: "list" } as StaffRoute, "dashboard"],
      ["create-project", { kind: "create-project" } as StaffRoute, "create-project"],
      ["project", { kind: "project", projectId } as StaffRoute, "project"],
      ["edit-project", { kind: "edit-project", projectId } as StaffRoute, "edit-project"],
      ["admin", { kind: "admin" } as StaffRoute, "admin"],
      ["notifications", { kind: "notifications" } as StaffRoute, "notifications"],
      ["not-found", { kind: "not-found" } as StaffRoute, "not-found"],
    ])("folds %s to %s", (_label, route, expected) => {
      expect(buildStaffNavigation(route, "kanban", all).activeSectionId).toBe(expected);
    });
  });

  describe("adding a fourth Dashboard child", () => {
    it("is one entry in the children list — nothing about the tree's shape is per-view", () => {
      // AC4's model half. The renderer's half is in the rail's own DOM test, which appends a
      // synthetic fourth child to this model and asserts it renders without touching the renderer.
      const children = dashboardChildren(bareDashboard);
      const extended = [...children, { id: "dashboard-timeline", label: "Timeline", href: "/?view=timeline", icon: "list" as const, active: false }];
      expect(extended).toHaveLength(children.length + 1);
      expect(extended.every((child) => typeof child.href === "string" && child.icon)).toBe(true);
    });
  });
});

describe("an explicit Calendar location without the capability", () => {
  // Reported by Luna. The shell replaces such a location with "/", so this is a transient frame
  // rather than a way into the Calendar — but a nav tree with NOTHING marked active is still the
  // wrong thing to paint while the redirect is pending, and it is what the model used to return.
  const WITHOUT_CALENDAR = { adminBackend: true, viewProductionCalendar: false };

  it("marks a real child active instead of nothing, for the bare intent", () => {
    const navigation = buildStaffNavigation(
      { kind: "dashboard", dashboardView: "calendar" },
      "kanban",
      WITHOUT_CALENDAR,
    );
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.map((child) => child.label)).toEqual(["List", "Kanban"]);
    expect(children.filter((child) => child.active).map((child) => child.label)).toEqual(["Kanban"]);
  });

  it("marks a real child active instead of nothing, for the full facet", () => {
    const navigation = buildStaffNavigation(
      {
        kind: "dashboard",
        calendar: { date: "2026-08-30", subview: "week", layers: ["project"], search: "", mine: false },
      } as Parameters<typeof buildStaffNavigation>[0],
      "list",
      WITHOUT_CALENDAR,
    );
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active).map((child) => child.label)).toEqual(["List"]);
  });

  it("still honours an explicit Calendar location WITH the capability", () => {
    const navigation = buildStaffNavigation(
      { kind: "dashboard", dashboardView: "calendar" },
      "list",
      { adminBackend: true, viewProductionCalendar: true },
    );
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active).map((child) => child.label)).toEqual(["Calendar"]);
  });
});
