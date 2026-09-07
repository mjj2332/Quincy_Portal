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

describe("staff router history — the router never writes the URL", () => {
  // @tanstack/react-router's Transitioner canonicalises the URL on mount, with no opt-out. Quincy
  // rejects percent-encoded spellings of static segments on purpose, so that replace would rewrite
  // /%61dmin to /admin and mount the real Admin screen. The router therefore gets a read-only
  // history; locationStore() remains the single writer, where safeStaffDestination still runs.
  it.each(["/admin", "/d/token", "/projects/new", "/"])(
    "drops a router-initiated push to %s without touching the browser",
    (destination) => {
      const { browser, history } = build("/%61dmin");
      history.push(destination);
      expect(browser.calls).toEqual([]);
    },
  );

  it("drops a router-initiated replace, which is the canonicalisation that caused the regression", () => {
    const { browser, history } = build("/%61dmin");
    history.replace("/admin");
    expect(browser.calls).toEqual([]);
    expect(history.location.href).toBe("/%61dmin");
  });

  it("still routes every real navigation through the sanitising adapter", () => {
    // The writer the application actually uses. safeStaffDestination runs here, unchanged.
    const { browser, adapter } = build("/");
    adapter.push("/d/token");
    adapter.push("/admin");
    adapter.replace(`/projects/${projectId}?collaboration=open`);
    expect(browser.calls).toEqual(["push:/", "push:/admin", `replace:/projects/${projectId}?collaboration=open`]);
  });

  it("notifies once per external write", () => {
    const { adapter, history } = build("/");
    let notifications = 0;
    history.subscribe(() => { notifications += 1; });
    adapter.push("/admin");
    expect(notifications).toBe(1);
    adapter.replace("/settings/notifications");
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
