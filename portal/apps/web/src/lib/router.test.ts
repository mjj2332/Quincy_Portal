import { describe, expect, it } from "vitest";
import { createHistoryAdapter, parseStaffPathname, safeStaffDestination, staffPathFor, shouldInterceptInternalLink } from "./router";
import { beginSignIn, consumeSignInDestinationFrom } from "./auth";

const projectId = "123e4567-e89b-42d3-a456-426614174000";

describe("staff route contract", () => {
  it("parses and serializes every canonical staff route", () => {
    expect(parseStaffPathname("/")).toEqual({ kind: "dashboard" });
    expect(parseStaffPathname("/projects/new")).toEqual({ kind: "create-project" });
    expect(parseStaffPathname(`/projects/${projectId}`)).toEqual({ kind: "project", projectId });
    expect(parseStaffPathname(`/projects/${projectId}/edit`)).toEqual({ kind: "edit-project", projectId });
    expect(parseStaffPathname("/admin")).toEqual({ kind: "admin" });
    expect(staffPathFor({ kind: "project", projectId })).toBe(`/projects/${projectId}`);
    expect(staffPathFor({ kind: "edit-project", projectId })).toBe(`/projects/${projectId}/edit`);
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
    for (const destination of [
      "https://quincy.flamingfire.my/admin", "//attacker.example", "\\admin", "/admin?next=/api", "/admin#x",
      "/d/token", "/api/projects", "/unknown", `/projects/${projectId.toUpperCase()}`,
      "/projects/%6eew", "/admin\u0000",
    ]) expect(safeStaffDestination(destination)).toBeNull();
  });
});

describe("History adapter", () => {
  it("pushes, replaces, and observes browser back/forward without creating entries on popstate", () => {
    let pathname = "/";
    const calls: string[] = [];
    let popstate: (() => void) | undefined;
    const history = createHistoryAdapter({
      location: { get pathname() { return pathname; } } as Location,
      history: {
        pushState: (_state, _title, path) => { pathname = String(path); calls.push(`push:${pathname}`); },
        replaceState: (_state, _title, path) => { pathname = String(path); calls.push(`replace:${pathname}`); },
      } as History,
      addEventListener: (_type, listener) => { popstate = listener; },
      removeEventListener: () => { popstate = undefined; },
    });
    const snapshots: string[] = [];
    const unsubscribe = history.subscribe(() => snapshots.push(history.getPathname()));
    history.push("/admin"); history.replace(`/projects/${projectId}`);
    pathname = "/"; popstate?.();
    unsubscribe();
    expect(calls).toEqual(["push:/admin", `replace:/projects/${projectId}`]);
    expect(snapshots).toEqual(["/admin", `/projects/${projectId}`, "/"]);
  });
});

describe("internal-link interception", () => {
  const click = (overrides: Partial<Parameters<typeof shouldInterceptInternalLink>[0]> = {}) => ({
    button: 0, detail: 1, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    currentTarget: { href: `https://portal.test/projects/${projectId}`, target: "", download: "" }, ...overrides,
  });

  it("only intercepts unmodified primary mouse navigation to a staff route", () => {
    expect(shouldInterceptInternalLink(click(), "https://portal.test")).toBe(true);
    expect(shouldInterceptInternalLink(click({ detail: 0 }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ metaKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ button: 1 }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ currentTarget: { href: `https://portal.test/projects/${projectId}`, target: "_blank", download: "" } }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ currentTarget: { href: "https://portal.test/d/token", target: "", download: "" } }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ currentTarget: { href: "https://example.test/", target: "", download: "" } }), "https://portal.test")).toBe(false);
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
    expect(consumeSignInDestinationFrom(saved)).toBe("/");
    expect(consumeSignInDestinationFrom(memoryStorage("/api/projects"))).toBe("/");
  });

  it("tolerates unavailable storage and clears a failed sign-in fallback", async () => {
    const unavailable = { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("disabled"); }, removeItem: () => { throw new Error("disabled"); } };
    expect(consumeSignInDestinationFrom(unavailable)).toBe("/");
    const saved = memoryStorage();
    await expect(beginSignIn(`/projects/${projectId}`, { signIn: { social: async () => ({ error: { message: "Nope" } }) } }, saved)).rejects.toThrow("Nope");
    expect(saved.value()).toBeNull();
  });
});
