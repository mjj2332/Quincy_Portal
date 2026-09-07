import { describe, expect, it } from "vitest";
import { createHistoryAdapter } from "./router";
import { createStaffRouterHistory, parseStaffSearch, stringifyStaffSearch } from "./staff-history";

const projectId = "123e4567-e89b-42d3-a456-426614174000";

/** A synthetic browser, matching the shape `router.test.ts` already drives the adapter with. */
function fakeBrowser(initial = "/") {
  const [initialPathname, initialSearch] = initial.split("?");
  let pathname = initialPathname ?? "/";
  let search = initialSearch ? `?${initialSearch}` : "";
  const calls: string[] = [];
  let popstate: (() => void) | undefined;
  const write = (kind: string, path: unknown) => {
    const [nextPathname, nextSearch] = String(path).split("?");
    pathname = nextPathname ?? "/";
    search = nextSearch ? `?${nextSearch}` : "";
    calls.push(`${kind}:${pathname}${search}`);
  };
  const source = {
    location: { get pathname() { return pathname; }, get search() { return search; } } as Location,
    history: {
      pushState: (_s: unknown, _t: unknown, path: unknown) => write("push", path),
      replaceState: (_s: unknown, _t: unknown, path: unknown) => write("replace", path),
    } as History,
    addEventListener: (_type: "popstate", listener: () => void) => { popstate = listener; },
    removeEventListener: () => { popstate = undefined; },
  };
  return {
    source,
    calls,
    /** Simulate a back/forward arrival: the browser has already moved, then tells us. */
    travelTo(next: string) {
      const [nextPathname, nextSearch] = next.split("?");
      pathname = nextPathname ?? "/";
      search = nextSearch ? `?${nextSearch}` : "";
      popstate?.();
    },
  };
}

function build(initial = "/") {
  const browser = fakeBrowser(initial);
  const adapter = createHistoryAdapter(browser.source);
  const { history, dispose } = createStaffRouterHistory(adapter);
  return { browser, adapter, history, dispose };
}

describe("staff search codec", () => {
  it("round-trips the exact query bytes the DOM suite asserts on", () => {
    // %2C and + survive: TanStack must never re-serialise Quincy's closed query contract.
    for (const raw of [
      "view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist&mine=1&q=smith+street",
      "view=list",
      "collaboration=open",
      "view=list&detail=123e4567-e89b-42d3-a456-426614174000",
    ]) {
      expect(stringifyStaffSearch(parseStaffSearch(`?${raw}`))).toBe(`?${raw}`);
    }
  });

  it("treats an absent and an empty query as the same nothing", () => {
    expect(parseStaffSearch("")).toEqual({});
    expect(parseStaffSearch("?")).toEqual({});
    expect(stringifyStaffSearch({})).toBe("");
    expect(stringifyStaffSearch(parseStaffSearch(""))).toBe("");
  });
});

describe("staff router history — reads are raw", () => {
  it("hands the router an arriving location byte-for-byte, including one the parser rejects", () => {
    // The load-bearing case: App.dom.test.tsx renders here and asserts the URL is untouched.
    const invalid = `/?view=list&detail=${projectId}`;
    const { history } = build(invalid);
    expect(history.location.href).toBe(invalid);
  });

  it("does not launder a location the parser would reject into a valid one", () => {
    // @tanstack/history's parseHref collapses a leading "//" — which is why nothing in this app
    // may decide what to render from history.location. parseStaffLocation reads the adapter's
    // raw location instead, and still sees the original.
    const { history, adapter } = build("//attacker.example");
    expect(adapter.getLocation()).toBe("//attacker.example");
    expect(history.location.href).not.toBe("//attacker.example");
  });

  it("observes a back/forward arrival without writing a history entry", () => {
    const { browser, history } = build("/");
    const seen: string[] = [];
    history.subscribe(({ location }) => seen.push(location.href));
    browser.travelTo("/?view=kanban");
    expect(seen).toEqual(["/?view=kanban"]);
    expect(browser.calls).toEqual([]);
  });

  it("forwards a write made by a component that renders outside the RouterProvider", () => {
    // Dashboard, Admin, ImpersonationBanner and InternalLink all navigate via locationStore().
    const { browser, adapter, history } = build("/");
    const seen: string[] = [];
    history.subscribe(({ location }) => seen.push(location.href));
    adapter.push("/admin");
    expect(seen).toEqual(["/admin"]);
    expect(browser.calls).toEqual(["push:/admin"]);
  });
});

describe("staff router history — writes are sanitised", () => {
  it.each([
    ["/d/token", "reserved delivery namespace"],
    ["/api/projects", "reserved backend namespace"],
    ["/unknown", "unroutable path"],
    [`/projects/${projectId.toUpperCase()}`, "non-canonical UUID casing"],
    [`/?view=list&detail=${projectId}`, "retired dashboard facet"],
  ])("collapses a router push to %s to / (%s)", (destination) => {
    const { browser, history } = build("/");
    history.push(destination);
    expect(browser.calls).toEqual(["push:/"]);
    expect(history.location.href).toBe("/");
  });

  it("collapses a router replace the same way", () => {
    const { browser, history } = build("/");
    history.replace("/d/token");
    expect(browser.calls).toEqual(["replace:/"]);
    expect(history.location.href).toBe("/");
  });

  it("passes a canonical destination through untouched", () => {
    const { browser, history } = build("/");
    history.push(`/projects/${projectId}?collaboration=open`);
    history.replace("/settings/notifications");
    expect(browser.calls).toEqual([`push:/projects/${projectId}?collaboration=open`, "replace:/settings/notifications"]);
    expect(history.location.href).toBe("/settings/notifications");
  });

  it("shows the router the committed location, never the rejected candidate", () => {
    // @tanstack/history re-reads getLocation() inside notify(), after pushState returns, so the
    // adapter's collapse is what the router sees. Without that, router and browser would disagree.
    const { history } = build("/");
    const seen: string[] = [];
    history.subscribe(({ location }) => seen.push(location.href));
    history.push("/d/token");
    expect(seen.every((href) => href === "/")).toBe(true);
    expect(seen).not.toContain("/d/token");
  });

  it("notifies exactly once per router-initiated write", () => {
    // The adapter notifies its own subscribers AND @tanstack/history notifies after pushState.
    // Forwarding both would double-fire every navigation.
    const { history } = build("/");
    let notifications = 0;
    history.subscribe(() => { notifications += 1; });
    history.push("/admin");
    expect(notifications).toBe(1);
    history.replace("/settings/notifications");
    expect(notifications).toBe(2);
  });
});

describe("staff router history — lifecycle", () => {
  it("stops observing the adapter once disposed", () => {
    const { adapter, history, dispose } = build("/");
    const seen: string[] = [];
    history.subscribe(({ location }) => seen.push(location.href));
    dispose();
    adapter.push("/admin");
    expect(seen).toEqual([]);
  });
});
