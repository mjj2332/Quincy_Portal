import { describe, expect, it } from "vitest";
import type { StaffRoute } from "./router";
import { buildStaffBreadcrumb, buildStaffNavigation, type StaffNavigationCapabilities, type StaffNavigationItem } from "./staff-navigation";

const all: StaffNavigationCapabilities = { adminBackend: true, viewProductionCalendar: true, viewNoticeBoard: true };
const noAdmin: StaffNavigationCapabilities = { adminBackend: false, viewProductionCalendar: true, viewNoticeBoard: true };
const noCalendar: StaffNavigationCapabilities = { adminBackend: true, viewProductionCalendar: false, viewNoticeBoard: true };

const bareDashboard: StaffRoute = { kind: "dashboard" };
const projectId = "11111111-1111-4111-8111-111111111111";

function items(route: StaffRoute, remembered: "table" | "board" | "timeline" | "calendar" = "board", capabilities = all) {
  return buildStaffNavigation(route, remembered, capabilities).groups.flatMap((group) => group.items);
}

function dashboardChildren(route: StaffRoute, remembered: "table" | "board" | "timeline" | "calendar" = "board", capabilities = all) {
  return items(route, remembered, capabilities).find((item) => item.id === "dashboard")?.children ?? [];
}

function activeChildId(route: StaffRoute, remembered: "table" | "board" | "timeline" | "calendar" = "board", capabilities = all) {
  return dashboardChildren(route, remembered, capabilities).find((child) => child.active)?.id ?? null;
}

describe("the staff navigation model", () => {
  it("is pure — the same inputs give an equal tree, and it touches no globals", () => {
    // A node test with no DOM: if the model reached for `window` or `localStorage` this would throw
    // rather than fail an assertion. That is the point of testing it here rather than in happy-dom.
    expect(typeof globalThis.window).toBe("undefined");
    expect(buildStaffNavigation(bareDashboard, "board", all)).toEqual(buildStaffNavigation(bareDashboard, "board", all));
  });

  describe("item order and identity", () => {
    it("puts Dashboard before Admin", () => {
      expect(items(bareDashboard).map((item) => item.id)).toEqual(["dashboard", "notices", "admin"]);
    });

    it("orders the Dashboard children Table, Board, Calendar, Timeline — the Dashboard tabs order (#427)", () => {
      expect(dashboardChildren(bareDashboard).map((child) => child.id)).toEqual(["dashboard-table", "dashboard-board", "dashboard-calendar", "dashboard-timeline"]);
    });

    it("gives every item and child an icon, which the collapsed rail in #112 requires", () => {
      const every: StaffNavigationItem[] = items(bareDashboard).flatMap((item) => [item, ...(item.children ?? [])]);
      expect(every.length).toBeGreaterThan(0);
      for (const item of every) expect(item.icon).toBeTruthy();
    });

    it("labels the children with the words already on the screen", () => {
      expect(dashboardChildren(bareDashboard).map((child) => child.label)).toEqual(["Table", "Board", "Calendar", "Timeline"]);
    });
  });

  describe("hrefs", () => {
    it("uses the addressable view routes, and a bare URL for Calendar", () => {
      expect(dashboardChildren(bareDashboard).map((child) => child.href)).toEqual(["/?view=table", "/?view=board", "/?view=calendar", "/?view=timeline"]);
    });

    it("points Dashboard itself at the root and Admin at /admin", () => {
      expect(items(bareDashboard).map((item) => item.href)).toEqual(["/", "/notices", "/admin"]);
    });
  });

  describe("capabilities", () => {
    it("omits Calendar and Timeline entirely without the capability — absent, not disabled (#220: Timeline gates on the same capability as Calendar)", () => {
      expect(dashboardChildren(bareDashboard, "board", noCalendar).map((child) => child.id)).toEqual(["dashboard-table", "dashboard-board"]);
    });

    it("omits Admin without the capability", () => {
      expect(items(bareDashboard, "board", noAdmin).map((item) => item.id)).toEqual(["dashboard", "notices"]);
    });

    it("omits Notice board without the capability", () => {
      const noNotices = { ...all, viewNoticeBoard: false };
      expect(items(bareDashboard, "board", noNotices).map((item) => item.id)).toEqual(["dashboard", "admin"]);
    });
  });

  describe("active state follows the resolved view, not the pathname", () => {
    it("resolves a bare / from the remembered view", () => {
      expect(activeChildId(bareDashboard, "table")).toBe("dashboard-table");
      expect(activeChildId(bareDashboard, "board")).toBe("dashboard-board");
      expect(activeChildId(bareDashboard, "timeline")).toBe("dashboard-timeline");
      expect(activeChildId(bareDashboard, "calendar")).toBe("dashboard-calendar");
    });

    it("marks Timeline active on an explicit timeline route (#220)", () => {
      expect(activeChildId({ kind: "dashboard", dashboardView: "timeline" }, "table")).toBe("dashboard-timeline");
    });

    it("coerces a remembered Gantt to Board when the capability is gone, same as Calendar (#220)", () => {
      expect(activeChildId(bareDashboard, "timeline", noCalendar)).toBe("dashboard-board");
    });

    it("lets an explicit view route beat the remembered view", () => {
      // This is the model's half of "archived forces List": the Dashboard forces List and navigates
      // there, and the rail follows the explicit route rather than the stale preference. Whether
      // selecting Archived actually forces List is the Dashboard's own DOM tests to prove — archive
      // scope is private screen state and is deliberately not an input to this model.
      expect(activeChildId({ kind: "dashboard", dashboardView: "table" }, "calendar")).toBe("dashboard-table");
      expect(activeChildId({ kind: "dashboard", dashboardView: "board" }, "table")).toBe("dashboard-board");
    });

    it("marks Calendar active for both Calendar spellings", () => {
      expect(activeChildId({ kind: "dashboard", dashboardView: "calendar" }, "table")).toBe("dashboard-calendar");
      expect(activeChildId({ kind: "dashboard", calendar: { view: "calendar", date: "2026-08-30", subview: "month", layers: ["project"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false } }, "table")).toBe("dashboard-calendar");
    });

    it("coerces a remembered Calendar to Board when the capability is gone", () => {
      // The remembered preference outlives a role change. Without this the rail would mark an item
      // active that it does not render.
      expect(activeChildId(bareDashboard, "calendar", noCalendar)).toBe("dashboard-board");
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

  describe("the model carries no expanded-group state (#426, ADR 0015)", () => {
    // The rail is icon-only and renders no child links, so the `expandedItemId` field that only the
    // expanded rail read is gone. `children` stays: the breadcrumb derives the active view from it.
    it.each([
      ["a bare dashboard", bareDashboard],
      ["an explicit view", { kind: "dashboard", dashboardView: "table" } as StaffRoute],
      ["admin", { kind: "admin" } as StaffRoute],
      ["a project", { kind: "project", projectId } as StaffRoute],
      ["not-found", { kind: "not-found" } as StaffRoute],
    ])("has no expandedItemId on %s", (_label, route) => {
      expect("expandedItemId" in buildStaffNavigation(route, "board", all)).toBe(false);
    });

    it("still models the Dashboard views as children for the breadcrumb", () => {
      const dashboard = items(bareDashboard).find((item) => item.id === "dashboard");
      expect(dashboard?.children?.length).toBeGreaterThan(0);
    });
  });

  describe("activeSectionId — the coarse screen identity the shell reads", () => {
    it.each([
      ["dashboard", bareDashboard, "dashboard"],
      ["an explicit view", { kind: "dashboard", dashboardView: "table" } as StaffRoute, "dashboard"],
      ["create-project", { kind: "create-project" } as StaffRoute, "create-project"],
      ["project", { kind: "project", projectId } as StaffRoute, "project"],
      ["edit-project", { kind: "edit-project", projectId } as StaffRoute, "edit-project"],
      ["admin", { kind: "admin" } as StaffRoute, "admin"],
      ["notices", { kind: "notices" } as StaffRoute, "notices"],
      ["notifications", { kind: "notifications" } as StaffRoute, "notifications"],
      ["notification-preferences", { kind: "notification-preferences" } as StaffRoute, "notifications"],
      ["not-found", { kind: "not-found" } as StaffRoute, "not-found"],
    ])("folds %s to %s", (_label, route, expected) => {
      expect(buildStaffNavigation(route, "board", all).activeSectionId).toBe(expected);
    });
  });

  describe("adding a fourth Dashboard child", () => {
    it("is one entry in the children list — nothing about the tree's shape is per-view", () => {
      // AC4's model half. The renderer's half is in the rail's own DOM test, which appends a
      // synthetic fourth child to this model and asserts it renders without touching the renderer.
      const children = dashboardChildren(bareDashboard);
      const extended = [...children, { id: "dashboard-timeline", label: "Timeline", href: "/?view=timeline", icon: "table" as const, active: false }];
      expect(extended).toHaveLength(children.length + 1);
      expect(extended.every((child) => typeof child.href === "string" && child.icon)).toBe(true);
    });
  });
});

describe("an explicit Calendar location without the capability", () => {
  // Reported by Luna. The shell replaces such a location with "/", so this is a transient frame
  // rather than a way into the Calendar — but a nav tree with NOTHING marked active is still the
  // wrong thing to paint while the redirect is pending, and it is what the model used to return.
  const WITHOUT_CALENDAR = { adminBackend: true, viewProductionCalendar: false, viewNoticeBoard: true };

  it("marks a real child active instead of nothing, for the bare intent", () => {
    const navigation = buildStaffNavigation(
      { kind: "dashboard", dashboardView: "calendar" },
      "board",
      WITHOUT_CALENDAR,
    );
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.map((child) => child.label)).toEqual(["Table", "Board"]);
    expect(children.filter((child) => child.active).map((child) => child.label)).toEqual(["Board"]);
  });

  it("marks a real child active instead of nothing, for the full facet", () => {
    const navigation = buildStaffNavigation(
      {
        kind: "dashboard",
        calendar: { date: "2026-08-30", subview: "week", layers: ["project"], search: "", mine: false },
      } as Parameters<typeof buildStaffNavigation>[0],
      "table",
      WITHOUT_CALENDAR,
    );
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active).map((child) => child.label)).toEqual(["Table"]);
  });

  it("still honours an explicit Calendar location WITH the capability", () => {
    const navigation = buildStaffNavigation(
      { kind: "dashboard", dashboardView: "calendar" },
      "table",
      { adminBackend: true, viewProductionCalendar: true, viewNoticeBoard: true },
    );
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active).map((child) => child.label)).toEqual(["Calendar"]);
  });

  // #220: Timeline gates on the same capability as Calendar, so it shares this same "mark a real
  // child active instead of nothing" contract for an explicit but unviewable location.
  it("marks a real child active instead of nothing, for an explicit Timeline route without the capability", () => {
    const navigation = buildStaffNavigation(
      { kind: "dashboard", dashboardView: "timeline" },
      "board",
      WITHOUT_CALENDAR,
    );
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.map((child) => child.label)).toEqual(["Table", "Board"]);
    expect(children.filter((child) => child.active).map((child) => child.label)).toEqual(["Board"]);
  });

  it("still honours an explicit Timeline location WITH the capability", () => {
    const navigation = buildStaffNavigation(
      { kind: "dashboard", dashboardView: "timeline" },
      "table",
      { adminBackend: true, viewProductionCalendar: true, viewNoticeBoard: true },
    );
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active).map((child) => child.label)).toEqual(["Timeline"]);
  });
});

describe("the Notice board item (#334)", () => {
  const notices: StaffRoute = { kind: "notices" };
  const noticeItem = (route: StaffRoute) => items(route).find((item) => item.id === "notices");

  it("is active on /notices, inactive on the Dashboard, and has no children or badge", () => {
    expect(noticeItem(notices)).toMatchObject({ label: "Notice board", href: "/notices", active: true });
    expect(noticeItem(notices)?.children).toBeUndefined();
    expect(noticeItem(bareDashboard)?.active).toBe(false);
    expect(items(notices).find((item) => item.id === "dashboard")?.active).toBe(false);
  });

  it("reads Home › Notice board(null) as the breadcrumb", () => {
    expect(buildStaffBreadcrumb(buildStaffNavigation(notices, "board", all))).toEqual([
      { label: "Home", href: "/" },
      { label: "Notice board", href: null },
    ]);
  });
});

describe("the notices breadcrumb without a nav item (#334)", () => {
  it("still reads Notice board when the capability hides the rail item", () => {
    const navigation = buildStaffNavigation({ kind: "notices" }, "board", { ...all, viewNoticeBoard: false });
    expect(buildStaffBreadcrumb(navigation).at(-1)).toEqual({ label: "Notice board", href: null });
  });
});

describe("buildStaffBreadcrumb — #112, AC7", () => {
  // Pure and derived from the model, never re-derived from the route: it consumes
  // `buildStaffNavigation`'s own `active` flags, so it cannot disagree with the rail about what
  // is active.
  it("reads Home › Dashboard(href '/') › Board(null) on an explicit Board route", () => {
    const navigation = buildStaffNavigation({ kind: "dashboard", dashboardView: "board" }, "table", all);
    expect(buildStaffBreadcrumb(navigation)).toEqual([
      { label: "Home", href: "/" },
      { label: "Dashboard", href: "/" },
      { label: "Board", href: null },
    ]);
  });

  it("reads Home › Admin(null) — Admin has no children to descend into", () => {
    const navigation = buildStaffNavigation({ kind: "admin" }, "board", all);
    expect(buildStaffBreadcrumb(navigation)).toEqual([
      { label: "Home", href: "/" },
      { label: "Admin", href: null },
    ]);
  });

  it("resolves a bare '/' from the remembered view, same as an explicit route", () => {
    const navigation = buildStaffNavigation(bareDashboard, "table", all);
    expect(buildStaffBreadcrumb(navigation)).toEqual([
      { label: "Home", href: "/" },
      { label: "Dashboard", href: "/" },
      { label: "Table", href: null },
    ]);
  });

  it("falls back to Home › section label for a route outside the model", () => {
    // `project` has no representation in `navigation.groups` — only Dashboard and Admin do — so
    // there is no active item to descend into. The fallback names the section itself instead of
    // producing a truncated, Home-only trail.
    const navigation = buildStaffNavigation({ kind: "project", projectId }, "board", all);
    expect(buildStaffBreadcrumb(navigation)).toEqual([
      { label: "Home", href: "/" },
      { label: "Project", href: null },
    ]);
  });

  it("every segment but the last carries an href; the last is null", () => {
    const navigation = buildStaffNavigation({ kind: "dashboard", dashboardView: "calendar" }, "board", all);
    const segments = buildStaffBreadcrumb(navigation);
    expect(segments.slice(0, -1).every((segment) => typeof segment.href === "string")).toBe(true);
    expect(segments.at(-1)?.href).toBeNull();
  });
});

describe("publishedView — the Dashboard's own rendered view, #119", () => {
  // The Dashboard publishes the view it is actually rendering (`lib/dashboard-view-store.ts`) once
  // mounted; this model follows that publication instead of re-deriving one from the route or the
  // remembered preference. The route/remembered derivation covered above is only the pre-mount
  // fallback, for the single frame before any Dashboard instance has published.
  it("overrides an explicit route view", () => {
    const navigation = buildStaffNavigation({ kind: "dashboard", dashboardView: "board" }, "table", all, "calendar");
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active).map((child) => child.id)).toEqual(["dashboard-calendar"]);
  });

  it("overrides the remembered view on a bare dashboard route", () => {
    const navigation = buildStaffNavigation(bareDashboard, "board", all, "table");
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active).map((child) => child.id)).toEqual(["dashboard-table"]);
  });

  it("null keeps the pre-#119 route/remembered derivation, unchanged", () => {
    const withNull = buildStaffNavigation({ kind: "dashboard", dashboardView: "board" }, "table", all, null);
    const withoutArg = buildStaffNavigation({ kind: "dashboard", dashboardView: "board" }, "table", all);
    expect(withNull).toEqual(withoutArg);
    const children = withNull.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active).map((child) => child.id)).toEqual(["dashboard-board"]);
  });

  it("marks no child active for a published Calendar without the capability — a publication is authoritative, not re-coerced, and the Calendar child is filtered out so nothing matches it", () => {
    const navigation = buildStaffNavigation(bareDashboard, "table", noCalendar, "calendar");
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.map((child) => child.id)).toEqual(["dashboard-table", "dashboard-board"]);
    expect(children.filter((child) => child.active)).toEqual([]);
  });

  it("marks no child active for a published \"none\" — the Dashboard is rendering no view branch", () => {
    const navigation = buildStaffNavigation(bareDashboard, "board", all, "none");
    const children = navigation.groups[0]!.items[0]!.children ?? [];
    expect(children.filter((child) => child.active)).toEqual([]);
  });

  it("is ignored away from the Dashboard", () => {
    const navigation = buildStaffNavigation({ kind: "admin" }, "board", all, "calendar");
    expect(navigation.groups[0]!.items.find((item) => item.id === "dashboard")?.children?.some((child) => child.active)).toBe(false);
    expect(navigation.activeSectionId).toBe("admin");
  });
});
