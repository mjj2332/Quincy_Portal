import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockSessionState = { value: { data: { user: { id: string; name: string; role: string } } | null; isPending: boolean; refetch: () => Promise<void> } };
const sessionState = vi.hoisted(() => ({ value: { data: { user: { id: "u1", name: "Ada", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() } } as MockSessionState));

vi.mock("./lib/auth", () => ({ useSession: () => sessionState.value, stopImpersonating: vi.fn(), consumeSignInDestination: () => null }));
vi.mock("./lib/stages", () => ({ StagesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./components/quincy/RailedShell", () => ({ RailedShell: ({ children }: { children: ReactNode }) => <><header />{children}</> }));
vi.mock("./lib/query-client", () => ({ QuincyQueryProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: () => <main>DASHBOARD SCREEN</main> }));
vi.mock("./screens/ProjectWorkspace", () => ({ ProjectWorkspace: ({ projectId }: { projectId: string }) => <main>PROJECT SCREEN {projectId}</main> }));
vi.mock("./screens/Admin", () => ({ Admin: ({ currentUserId }: { currentUserId: string }) => <main>ADMIN SCREEN {currentUserId}</main> }));
vi.mock("./screens/CreateProject", () => ({ CreateProject: () => <main>CREATE SCREEN</main> }));
vi.mock("./screens/EditProject", () => ({ EditProject: ({ projectId }: { projectId: string }) => <main>EDIT SCREEN {projectId}</main> }));
vi.mock("./screens/Notifications", () => ({ Notifications: () => <main>NOTIFICATIONS LIST SCREEN</main> }));
vi.mock("./screens/NotificationPreferences", () => ({ NotificationPreferences: () => <main>NOTIFICATIONS PREFERENCES SCREEN</main> }));
vi.mock("./screens/SignIn", () => ({ SignIn: () => <main>SIGN IN</main> }));

import App from "./App";
import { locationStore } from "./lib/router";

/**
 * #266 — the router's scroll reset. TanStack's `onRendered` subscriber scrolls to the top after
 * every render its history is notified of, and every staff URL write notifies it. A query-only
 * change (a Gantt or Calendar filter, a search commit, a view switch) must keep the reader where
 * they are; a real screen change (a new pathname) still lands at the top.
 */
const projectId = "123e4567-e89b-42d3-a456-426614174000";
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scrollTo = vi.fn();

beforeEach(() => {
  sessionState.value = { data: { user: { id: "u1", name: "Ada", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
  scrollTo.mockReset();
  vi.stubGlobal("scrollTo", scrollTo);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

async function renderAt(path: string, strict = false) {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(strict ? <StrictMode><App /></StrictMode> : <App />); await Promise.resolve(); await Promise.resolve(); });
  return host;
}

async function write(kind: "push" | "replace", location: string) {
  await act(async () => { locationStore()[kind](location); await Promise.resolve(); await Promise.resolve(); });
}

const resetsToTop = () => scrollTo.mock.calls.filter(([options]) => typeof options === "object" && options?.top === 0 && options?.left === 0).length;

describe("router scroll reset (#266)", () => {
  it("keeps the scroll position on a query-only push or replace", async () => {
    await renderAt("/?view=gantt");
    scrollTo.mockReset();
    await write("push", "/?view=gantt&stages=raw_review");
    await write("replace", "/?view=gantt&stages=raw_review&q=smith");
    await write("push", "/?view=list&q=smith");
    expect(resetsToTop()).toBe(0);
  });

  it("keeps the scroll position when Back/Forward stays on the same pathname", async () => {
    await renderAt("/?view=gantt");
    await write("push", "/?view=gantt&stages=raw_review");
    scrollTo.mockReset();
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(resetsToTop()).toBe(0);
  });

  it("still lands at the top when the pathname changes", async () => {
    await renderAt("/?view=gantt&stages=raw_review");
    scrollTo.mockReset();
    // #366: `/projects/<id>` is a sheet over the Dashboard, no longer a "new screen" — /admin is.
    await write("push", "/admin");
    expect(resetsToTop()).toBe(1);
    scrollTo.mockReset();
    await write("push", "/?view=gantt");
    expect(resetsToTop()).toBe(1);
  });

  it("#366: opening and closing the Project sheet, and moving between two Projects, never reset the scroll", async () => {
    const other = "223e4567-e89b-42d3-a456-426614174000";
    await renderAt("/?view=list");
    scrollTo.mockReset();
    await write("push", `/projects/${projectId}`);
    await write("push", `/projects/${other}`);
    await write("push", "/?view=list");
    expect(resetsToTop()).toBe(0);
  });

  it("#366: leaving the Project sheet for another screen still lands at the top", async () => {
    await renderAt(`/projects/${projectId}`);
    scrollTo.mockReset();
    await write("push", "/admin");
    expect(resetsToTop()).toBe(1);
  });

  it("keeps a query-only change still after a pathname change, under StrictMode", async () => {
    await renderAt(`/projects/${projectId}`, true);
    await write("push", "/?view=list");
    scrollTo.mockReset();
    await write("push", "/?view=list&q=smith");
    expect(resetsToTop()).toBe(0);
  });

  it("leaves an arriving non-canonical location byte-exact (no canonicalising write)", async () => {
    await renderAt("/%61dmin");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/%61dmin");
  });
});
