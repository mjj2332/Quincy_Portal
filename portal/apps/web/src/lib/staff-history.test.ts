import { describe, expect, it } from "vitest";
import { parseHref } from "@tanstack/history";
import { createHistoryAdapter, parseStaffLocation, staffPathFor } from "./router";
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
  const { history, connect } = createStaffRouterHistory(adapter);
  // Connected, as it is whenever the router is mounted.
  const disconnect = connect();
  return { browser, adapter, history, connect, disconnect };
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

describe("the property the read-only history rests on", () => {
  // The router's writes are suppressed because the only thing that can provoke one is a location
  // TanStack would rebuild differently from how it arrived. The claim that matters is therefore
  // NOT "only percent-escapes provoke it" -- a leading "//" and a bare "?" do too, with no escape
  // in sight -- but that NO location the parser ACCEPTS is ever rebuilt differently. That is the
  // sentence a future reader will lean on, so it is checked here rather than asserted in a comment.
  const canonical = [
    "/",
    "/?view=list",
    "/?view=kanban",
    "/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist&mine=1&q=smith+street",
    "/projects/new",
    `/projects/${projectId}`,
    `/projects/${projectId}?collaboration=open`,
    `/projects/${projectId}/edit`,
    "/admin",
    "/settings/notifications",
    "/settings/notifications/preferences",
  ];

  it("rebuilds every canonical staff location to itself, byte for byte", () => {
    for (const href of canonical) {
      // The transforms TanStack applies to an arriving location before comparing.
      const parsed = parseHref(href, undefined);
      const rebuilt = parsed.pathname + stringifyStaffSearch(parseStaffSearch(parsed.search));
      expect(rebuilt, `${href} would be rewritten to ${rebuilt}`).toBe(href);
    }
  });

  it("covers every route kind the app can navigate to, so the corpus cannot silently shrink", () => {
    const kinds = new Set(canonical.map((href) => parseStaffLocation(href).kind));
    expect(kinds).toEqual(new Set(["dashboard", "create-project", "project", "edit-project", "admin", "notifications", "notification-preferences"]));
    // Anchored to the serializer: if a new kind is added, staffPathFor gains an arm and this list
    // must grow with it.
    expect(canonical).toContain(staffPathFor({ kind: "admin" }));
    expect(canonical).toContain(staffPathFor({ kind: "notifications" }));
    expect(canonical).toContain(staffPathFor({ kind: "notification-preferences" }));
    expect(canonical).toContain(staffPathFor({ kind: "create-project" }));
  });

  it("shows the rewrite triggers really exist, and that each is a location the parser rejects", () => {
    // Without this the test above could pass because nothing ever triggers a rewrite at all.
    for (const href of ["//x", "/?"]) {
      const parsed = parseHref(href, undefined);
      const rebuilt = parsed.pathname + stringifyStaffSearch(parseStaffSearch(parsed.search));
      expect(rebuilt, `${href} was expected to be rewritten`).not.toBe(href);
      expect(parseStaffLocation(href).kind).toBe("not-found");
    }
  });
});

describe("staff router history — lifecycle", () => {
  it("stops observing the adapter once disconnected", () => {
    const { adapter, history, disconnect } = build("/");
    const seen: string[] = [];
    history.subscribe(({ location }) => seen.push(location.href));
    disconnect();
    adapter.push("/admin");
    expect(seen).toEqual([]);
  });

  it("can be reconnected after a disconnect, which is what StrictMode requires", () => {
    // StrictMode runs mount -> cleanup -> mount. If connecting were a one-shot done at
    // construction, the cleanup would leave the router permanently deaf.
    const { adapter, history, connect, disconnect } = build("/");
    const seen: string[] = [];
    history.subscribe(({ location }) => seen.push(location.href));
    disconnect();
    connect();
    adapter.push("/admin");
    expect(seen).toEqual(["/admin"]);
  });
});
