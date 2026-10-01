import { describe, expect, it, vi } from "vitest";
import { createHistoryAdapter, isDashboardLayerLocation, isSheetLocation, nextPushState, readSheetEntryState, parseStaffLocation, parseStaffPathname, projectNotificationRoute, safeStaffDestination, staffPathFor, shouldInterceptInternalLink, stripDashboardSearchFromLocation } from "./router";
import { beginSignIn, consumeSignInDestinationFrom } from "./auth";

const projectId = "123e4567-e89b-42d3-a456-426614174000";

describe("staff route contract", () => {
  it("parses and serializes every canonical staff route", () => {
    expect(parseStaffPathname("/")).toEqual({ kind: "dashboard" });
    expect(parseStaffPathname("/projects/new")).toEqual({ kind: "create-project" });
    expect(parseStaffPathname(`/projects/${projectId}`)).toEqual({ kind: "project", projectId });
    expect(parseStaffPathname(`/projects/${projectId}/edit`)).toEqual({ kind: "edit-project", projectId });
    expect(parseStaffPathname("/admin")).toEqual({ kind: "admin" });
    expect(parseStaffPathname("/settings/notifications")).toEqual({ kind: "notifications" });
    expect(parseStaffPathname("/settings/notifications/preferences")).toEqual({ kind: "notification-preferences" });
    expect(staffPathFor({ kind: "project", projectId })).toBe(`/projects/${projectId}`);
    expect(parseStaffLocation(`/projects/${projectId}?collaboration=open`)).toEqual({ kind: "project", projectId, arrivalTab: "collaboration" });
    expect(staffPathFor({ kind: "project", projectId, arrivalTab: "collaboration" })).toBe(`/projects/${projectId}?collaboration=open`);
    expect(parseStaffLocation(`/projects/${projectId}?tab=edited`)).toEqual({ kind: "project", projectId, arrivalTab: "edited" });
    expect(staffPathFor({ kind: "project", projectId, arrivalTab: "raw" })).toBe(`/projects/${projectId}?tab=raw`);
    expect(staffPathFor({ kind: "edit-project", projectId })).toBe(`/projects/${projectId}/edit`);
    expect(staffPathFor({ kind: "notifications" })).toBe("/settings/notifications");
    expect(staffPathFor({ kind: "notification-preferences" })).toBe("/settings/notifications/preferences");
  });

  it("keeps parser-only canonical UUID casing and static route precedence strict", () => {
    expect(parseStaffPathname("/projects/new")).toEqual({ kind: "create-project" });
    expect(parseStaffPathname(`/projects/${projectId.toUpperCase()}`)).toEqual({ kind: "not-found" });
    expect(parseStaffPathname("/projects/123e4567-e89b-42d3-a456-42661417400")).toEqual({ kind: "not-found" });
    expect(parseStaffPathname("/projects/%6eew")).toEqual({ kind: "not-found" });
    expect(parseStaffPathname("/%61dmin")).toEqual({ kind: "not-found" });
  });

  it("rejects malformed, non-canonical, and backtracking locations", () => {
    for (const pathname of [
      "/projects/", `/projects/${projectId}/`, `/projects/${projectId}/more`, "/projects//new",
      "/projects/%", "/projects/%2F", "/projects/%5c", "/projects/../admin", "/projects/./new",
      "/unknown", "/admin?tab=users", "/admin#settings",
    ]) expect(parseStaffPathname(pathname)).toEqual({ kind: "not-found" });
  });

  it("classifies delivery and backend namespaces as reserved", () => {
    for (const pathname of ["/d", "/d/", "/d/token", "/api", "/api/projects", "/media", "/media/asset/x", "/__transform-source", "/__transform-source/x"]) {
      expect(parseStaffPathname(pathname)).toEqual({ kind: "reserved" });
    }
  });

  it("only accepts canonical pathname-only OAuth destinations", () => {
    expect(safeStaffDestination(`/projects/${projectId}/edit`)).toBe(`/projects/${projectId}/edit`);
    expect(safeStaffDestination(`/projects/${projectId}?collaboration=open`)).toBe(`/projects/${projectId}?collaboration=open`);
    // #337: a signed-out click on a Raw/Edited notification email keeps its tab through sign-in.
    expect(safeStaffDestination(`/projects/${projectId}?tab=edited`)).toBe(`/projects/${projectId}?tab=edited`);
    expect(safeStaffDestination(`/projects/${projectId}?tab=raw`)).toBe(`/projects/${projectId}?tab=raw`);
    expect(safeStaffDestination(`/projects/${projectId}?tab=collaboration`)).toBeNull();
    for (const destination of [
      "https://quincy.flamingfire.my/admin", "//attacker.example", "\\admin", "/admin?next=/api", "/admin#x",
      "/d/token", "/api/projects", "/unknown", `/projects/${projectId.toUpperCase()}`,
      "/projects/%6eew", "/admin\u0000",
    ]) expect(safeStaffDestination(destination)).toBeNull();
    expect(safeStaffDestination("/settings/notifications")).toBe("/settings/notifications");
    expect(safeStaffDestination("/settings/notifications/preferences")).toBe("/settings/notifications/preferences");
  });

  it("keeps the one-shot query strict", () => {
    for (const location of [`/projects/${projectId}?collaboration=close`, `/projects/${projectId}?collaboration=open&x=1`, `/projects/${projectId}?collaboration=open&collaboration=open`, `/admin?tab=users`, `/projects/${projectId}?x=collaboration%3Dopen`, `/projects/${projectId}?collaboration=open#x`]) expect(parseStaffLocation(location)).toEqual({ kind: "not-found" });
  });

  it("accepts a canonical Calendar destination and preserves it through OAuth return", async () => {
    const calendar = `/?view=calendar&date=2026-08-30&sub=week&layers=project%2Cchecklist&mine=1&q=smith+street`;
    expect(parseStaffLocation(calendar)).toMatchObject({ kind: "dashboard", calendar: { subview: "week", myTasks: true, search: "smith street" } });
    expect(safeStaffDestination(calendar)).toBe(calendar);

    const saved = (() => {
      let current: string | null = calendar;
      return {
        getItem: () => current,
        setItem: (_key: string, value: string) => { current = value; },
        removeItem: () => { current = null; },
      };
    })();
    expect(consumeSignInDestinationFrom(saved)).toBe(calendar);

    const social = vi.fn(async ({ callbackURL }: { callbackURL: string }) => {
      expect(callbackURL).toBe(calendar);
      return {};
    });
    await beginSignIn(calendar, { signIn: { social } }, saved);
  });

  it("projects notification destinations consistently", () => {
    // #337: every declared type names its Workspace tab (the table in the issue).
    for (const type of ["raw_ready", "sent_to_editing", "autohdr_stalled"]) {
      expect(projectNotificationRoute(projectId, type)).toEqual({ kind: "project", projectId, arrivalTab: "raw" });
    }
    for (const type of ["edited_landed", "delivered"]) {
      expect(projectNotificationRoute(projectId, type)).toEqual({ kind: "project", projectId, arrivalTab: "edited" });
    }
    for (const type of ["comment_added", "assigned_to_project", "mentioned", "subtask_assigned", "subtask_due_today", "subtask_reminder", "project_deadline_reminder", "project_activity", "project_collaboration_activity"]) {
      expect(projectNotificationRoute(projectId, type)).toEqual({ kind: "project", projectId, arrivalTab: "collaboration" });
    }
    // A stored type the app no longer declares still opens the Project, on its default tab.
    expect(projectNotificationRoute(projectId, "other")).toEqual({ kind: "project", projectId });
    expect(projectNotificationRoute(null, "mentioned")).toBeUndefined();
    expect(projectNotificationRoute(null, "raw_ready")).toBeUndefined();
  });
});

// #217 fix round 5, item 3 (Sol re-review, BLOCKER). Explicit sign-out must scrub the Dashboard
// search out of the CURRENT location before signing out — otherwise `lib/auth.ts`'s own
// `beginSignIn`/`consumeSignInDestinationFrom` (see "accepts a canonical Calendar destination and
// preserves it through OAuth return" above, which this deliberately does NOT touch) faithfully
// carries it back for whoever signs in next.
describe("stripDashboardSearchFromLocation (#217 fix round 5, item 3)", () => {
  it("strips q from the bare, List, Kanban and Calendar-intent Dashboard arms", () => {
    expect(stripDashboardSearchFromLocation("/?q=smith")).toBe("/");
    expect(stripDashboardSearchFromLocation("/?view=table&q=smith")).toBe("/?view=table");
    expect(stripDashboardSearchFromLocation("/?view=board&q=smith")).toBe("/?view=board");
    expect(stripDashboardSearchFromLocation("/?view=calendar&q=smith")).toBe("/?view=calendar");
  });

  it("strips the search field from the canonical Calendar facet, keeping every other filter", () => {
    const location = "/?view=calendar&date=2026-08-30&sub=week&layers=project%2Cchecklist&mine=1&q=smith+street";
    expect(stripDashboardSearchFromLocation(location)).toBe("/?view=calendar&date=2026-08-30&sub=week&layers=project%2Cchecklist&mine=1");
  });

  it("is a no-op on a Dashboard location that already carries no search", () => {
    expect(stripDashboardSearchFromLocation("/")).toBe("/");
    expect(stripDashboardSearchFromLocation("/?view=board")).toBe("/?view=board");
  });

  // #217 fix round 6, item 2 (Sol re-review, NIT). A whitespace-only `q` normalises to no search
  // at PARSE time (#217 fix round 5, item 4) -- `parseStaffLocation("/?q=+++")` already reads as
  // the plain `{ kind: "dashboard" }` route, with no `search` field to remove. The early-return
  // "unchanged" path treated that as already-stripped and handed back the ORIGINAL location,
  // literal `q=+++` and all, rather than the canonical URL the parsed (searchless) route actually
  // describes. Serialising from the parsed route unconditionally (never returning the raw input
  // string except for a non-Dashboard location, where there is nothing to strip in the first
  // place) is what removes the literal param regardless of whether it was semantically empty.
  it("removes a whitespace-only q param entirely, not just the search it normalises to", () => {
    expect(stripDashboardSearchFromLocation("/?q=+++")).toBe("/");
    expect(stripDashboardSearchFromLocation("/?view=board&q=+++")).toBe("/?view=board");
    expect(stripDashboardSearchFromLocation("/?view=calendar&q=+++")).toBe("/?view=calendar");
  });

  it("leaves a non-Dashboard location untouched — nothing there carries a Dashboard search", () => {
    expect(stripDashboardSearchFromLocation(`/projects/${projectId}`)).toBe(`/projects/${projectId}`);
    expect(stripDashboardSearchFromLocation("/admin")).toBe("/admin");
  });
});

describe("History adapter", () => {
  it("pushes, replaces, and observes browser back/forward without creating entries on popstate", () => {
    let pathname = "/"; let search = "";
    const calls: string[] = [];
    let popstate: (() => void) | undefined;
    const history = createHistoryAdapter({
      location: { get pathname() { return pathname; }, get search() { return search; } } as Location,
      history: {
        pushState: (_state, _title, path) => { const [nextPathname, nextSearch] = String(path).split("?"); pathname = nextPathname ?? "/"; search = nextSearch ? `?${nextSearch}` : ""; calls.push(`push:${pathname}${search}`); },
        replaceState: (_state, _title, path) => { const [nextPathname, nextSearch] = String(path).split("?"); pathname = nextPathname ?? "/"; search = nextSearch ? `?${nextSearch}` : ""; calls.push(`replace:${pathname}${search}`); },
      } as History,
      addEventListener: (_type, listener) => { popstate = listener; },
      removeEventListener: () => { popstate = undefined; },
    });
    const snapshots: string[] = [];
    const unsubscribe = history.subscribe(() => snapshots.push(history.getLocation()));
    history.push("/admin"); history.replace(`/projects/${projectId}?collaboration=open`);
    pathname = "/"; search = ""; popstate?.();
    unsubscribe();
    expect(calls).toEqual(["push:/admin", `replace:/projects/${projectId}?collaboration=open`]);
    expect(snapshots).toEqual(["/admin", `/projects/${projectId}?collaboration=open`, "/"]);
  });
});

describe("history adapter navigation epoch (#367)", () => {
  it("bumps on push and popstate, never on replace, even for an identical URL", () => {
    let popstate: (() => void) | undefined;
    const location = { pathname: `/projects/${projectId}`, search: "?tab=raw" };
    const history = createHistoryAdapter({
      location: location as Location,
      history: { pushState: () => undefined, replaceState: () => undefined } as unknown as History,
      addEventListener: (_type, listener) => { popstate = listener; },
      removeEventListener: () => { popstate = undefined; },
    });
    const unsubscribe = history.subscribe(() => undefined);
    expect(history.getNavigationEpoch()).toBe(0);
    history.replace(`/projects/${projectId}?tab=raw`);
    expect(history.getNavigationEpoch()).toBe(0);
    history.push(`/projects/${projectId}?tab=raw`);
    expect(history.getNavigationEpoch()).toBe(1);
    popstate?.();
    expect(history.getNavigationEpoch()).toBe(2);
    history.replace(`/projects/${projectId}?tab=edited`);
    expect(history.getNavigationEpoch()).toBe(2);
    unsubscribe();
  });
});

describe("internal-link interception", () => {
  const click = (overrides: Partial<Parameters<typeof shouldInterceptInternalLink>[0]> = {}) => ({
    button: 0, detail: 1, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    currentTarget: { href: `https://portal.test/projects/${projectId}`, target: "", download: "" }, ...overrides,
  });

  it("only intercepts unmodified primary mouse navigation to a staff route", () => {
    expect(shouldInterceptInternalLink(click(), "https://portal.test")).toBe(true);
    expect(shouldInterceptInternalLink(click({ detail: 0 }), "https://portal.test")).toBe(true);
    expect(shouldInterceptInternalLink(click({ detail: 0, ctrlKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ detail: 0, shiftKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ metaKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ button: 1 }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ currentTarget: { href: `https://portal.test/projects/${projectId}`, target: "_blank", download: "" } }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ currentTarget: { href: "https://portal.test/d/token", target: "", download: "" } }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ currentTarget: { href: "https://example.test/", target: "", download: "" } }), "https://portal.test")).toBe(false);
  });

  it("intercepts a same-origin canonical Calendar link", () => {
    const calendar = "https://portal.test/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist";
    expect(shouldInterceptInternalLink(click({ currentTarget: { href: calendar, target: "", download: "" } }), "https://portal.test")).toBe(true);
  });
});

describe("one-time OAuth return fallback", () => {
  function memoryStorage(value: string | null = null) {
    let current = value;
    return {
      getItem: () => current,
      setItem: (_key: string, next: string) => { current = next; },
      removeItem: () => { current = null; },
      value: () => current,
    };
  }

  it("consumes and validates a stored destination exactly once", () => {
    const saved = memoryStorage(`/projects/${projectId}`);
    expect(consumeSignInDestinationFrom(saved)).toBe(`/projects/${projectId}`);
    expect(saved.value()).toBeNull();
    expect(consumeSignInDestinationFrom(saved)).toBeNull();
    expect(consumeSignInDestinationFrom(memoryStorage("/api/projects"))).toBe("/");
  });

  it("returns null (does not redirect) when nothing was ever stored", () => {
    // The real-world case: a fresh tab, refresh, bookmark, or shared link where no sign-in
    // flow just happened. Must not be treated the same as an invalid stored candidate.
    expect(consumeSignInDestinationFrom(memoryStorage())).toBeNull();
    expect(consumeSignInDestinationFrom(null)).toBeNull();
  });

  it("tolerates unavailable storage and clears a failed sign-in fallback", async () => {
    const unavailable = { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("disabled"); }, removeItem: () => { throw new Error("disabled"); } };
    expect(consumeSignInDestinationFrom(unavailable)).toBeNull();
    const saved = memoryStorage();
    await expect(beginSignIn(`/projects/${projectId}`, { signIn: { social: async () => ({ error: { message: "Nope" } }) } }, saved)).rejects.toThrow("Nope");
    expect(saved.value()).toBeNull();
  });
});

describe("Project sheet entry state (#366)", () => {
  const project = `/projects/${projectId}`;
  const otherProject = "/projects/223e4567-e89b-42d3-a456-426614174000";
  const valid = (overrides: Record<string, unknown> = {}) => ({ quincySheet: { v: 1, backdrop: "/?view=board&q=smith", depth: 1, prev: "/?view=board&q=smith", ...overrides } });

  it("reads a valid state and rejects every tampered or malformed shape", () => {
    expect(readSheetEntryState(valid())).toEqual({ v: 1, backdrop: "/?view=board&q=smith", depth: 1, prev: "/?view=board&q=smith" });
    for (const bad of [
      null, undefined, "x", 3, {}, { quincySheet: null }, { quincySheet: "x" },
      valid({ v: 2 }), valid({ depth: 0 }), valid({ depth: -1 }), valid({ depth: 1.5 }), valid({ depth: "1" }),
      valid({ backdrop: "/admin" }), valid({ backdrop: "//evil" }), valid({ backdrop: "https://evil.test/" }), valid({ backdrop: project }), valid({ backdrop: 5 }),
      valid({ prev: "//evil" }), valid({ prev: 7 }),
    ]) expect(readSheetEntryState(bad)).toBeNull();
  });

  it("classifies sheet and dashboard-layer locations", () => {
    expect(isSheetLocation(project)).toBe(true);
    expect(isSheetLocation(`${project}?tab=raw`)).toBe(true);
    expect(isSheetLocation("/")).toBe(false);
    expect(isSheetLocation(`${project}/edit`)).toBe(true);
    expect(isSheetLocation("/projects/new")).toBe(false);
    expect(isDashboardLayerLocation("/?view=table")).toBe(true);
    expect(isDashboardLayerLocation(project)).toBe(true);
    expect(isDashboardLayerLocation("/admin")).toBe(false);
    expect(isDashboardLayerLocation(`${project}/edit`)).toBe(true);
    expect(isDashboardLayerLocation("/projects/new")).toBe(false);
  });

  it("computes the state a push writes", () => {
    // dashboard -> sheet
    expect(nextPushState("/?view=table&q=a", null, project)).toEqual({ quincySheet: { v: 1, backdrop: "/?view=table&q=a", depth: 1, prev: "/?view=table&q=a" } });
    // sheet (with state) -> sheet
    expect(nextPushState(project, valid(), otherProject)).toEqual({ quincySheet: { v: 1, backdrop: "/?view=board&q=smith", depth: 2, prev: project } });
    // project -> edit (#374): depth + 1, prev is the project URL; and edit with no state stays stateless
    expect(nextPushState(project, valid(), `${project}/edit`)).toEqual({ quincySheet: { v: 1, backdrop: "/?view=board&q=smith", depth: 2, prev: project } });
    expect(nextPushState(project, null, `${project}/edit`)).toBeNull();
    // cold sheet (no state) -> sheet: nothing provable
    expect(nextPushState(project, null, otherProject)).toBeNull();
    expect(nextPushState(project, valid({ depth: 0 }), otherProject)).toBeNull();
    // destination not a sheet
    expect(nextPushState("/", null, "/admin")).toBeNull();
    expect(nextPushState(project, valid(), "/")).toBeNull();
    // current is neither dashboard nor sheet
    expect(nextPushState("/admin", null, project)).toBeNull();
  });

  function fakeHistory(initialState: unknown, initial = "/") {
    let pathname = initial.split("?")[0]!; let search = initial.includes("?") ? `?${initial.split("?")[1]}` : "";
    let state = initialState;
    const writes: Array<{ kind: string; state: unknown; path: string }> = [];
    const gos: number[] = [];
    const set = (kind: string, s: unknown, path: unknown) => {
      const [a, b] = String(path).split("?"); pathname = a!; search = b ? `?${b}` : ""; state = s; writes.push({ kind, state: s, path: String(path) });
    };
    const adapter = createHistoryAdapter({
      location: { get pathname() { return pathname; }, get search() { return search; } } as Location,
      history: {
        get state() { return state; },
        pushState: (s: unknown, _t: unknown, path: unknown) => set("push", s, path),
        replaceState: (s: unknown, _t: unknown, path: unknown) => set("replace", s, path),
        go: (n: number) => { gos.push(n); },
      } as unknown as History,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    return { adapter, writes, gos };
  }

  it("push writes the sheet state; replace keeps it only sheet-to-sheet; go delegates", () => {
    const { adapter, writes, gos } = fakeHistory(null, "/?view=table");
    adapter.push(project);
    expect(writes[0]).toEqual({ kind: "push", path: project, state: { quincySheet: { v: 1, backdrop: "/?view=table", depth: 1, prev: "/?view=table" } } });
    // a tab write (replace, sheet -> sheet) keeps the bookkeeping
    adapter.replace(`${project}?tab=raw`);
    expect(writes[1]!.state).toEqual(writes[0]!.state);
    // replace to a non-sheet location drops it
    adapter.replace("/");
    expect(writes[2]!.state).toBeNull();
    // replace from a non-sheet location into a sheet does not conjure state
    adapter.replace(project);
    expect(writes[3]!.state).toBeNull();
    adapter.go(-2);
    expect(gos).toEqual([-2]);
  });

  it("stacked sheet pushes count depth; a non-sheet push carries no state", () => {
    const { adapter, writes } = fakeHistory(null, "/");
    adapter.push(project);
    adapter.push("/projects/223e4567-e89b-42d3-a456-426614174000");
    expect(writes[1]!.state).toEqual({ quincySheet: { v: 1, backdrop: "/", depth: 2, prev: project } });
    adapter.push("/admin");
    expect(writes[2]!.state).toBeNull();
  });
});
