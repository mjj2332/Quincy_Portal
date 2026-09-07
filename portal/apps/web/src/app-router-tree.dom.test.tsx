/**
 * Proves the route tree is load-bearing (#52).
 *
 * `App.dom.test.tsx` exercises the dashboard and project arms, but nothing in the existing suite
 * mounts Admin, Create project, Edit project or Notification preferences *through the router* —
 * its one `/admin` case returns early on the invalidated-impersonation path, before a router
 * exists. Deleting those four leaves from the tree left the whole suite green, which is precisely
 * the shape `docs/lessons.md` warns about: a route tree that renders nothing anyone checks is
 * decoration, and a migration that ships one has not actually migrated navigation.
 *
 * This file closes that hole. Every arm of the tree is asserted here, so removing any leaf turns
 * a test red. It is a NEW file: no existing test was modified, which is what lets the unmodified
 * suite keep certifying that behaviour did not change.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockSessionState = { value: { data: { user: { id: string; name: string; role: string } } | null; isPending: boolean; refetch: () => Promise<void> } };
const sessionState = vi.hoisted(() => ({ value: { data: { user: { id: "u1", name: "Ada", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() } } as MockSessionState));

vi.mock("./lib/auth", () => ({ useSession: () => sessionState.value, stopImpersonating: vi.fn(), consumeSignInDestination: () => null }));
vi.mock("./lib/stages", () => ({ StagesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./components/Topbar", () => ({ Topbar: () => <header /> }));
vi.mock("./lib/query-client", () => ({ QuincyQueryProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: () => <main>DASHBOARD SCREEN</main> }));
vi.mock("./screens/ProjectWorkspace", () => ({ ProjectWorkspace: ({ projectId }: { projectId: string }) => <main>PROJECT SCREEN {projectId}</main> }));
vi.mock("./screens/Admin", () => ({ Admin: ({ currentUserId }: { currentUserId: string }) => <main>ADMIN SCREEN {currentUserId}</main> }));
vi.mock("./screens/CreateProject", () => ({ CreateProject: () => <main>CREATE SCREEN</main> }));
vi.mock("./screens/EditProject", () => ({ EditProject: ({ projectId }: { projectId: string }) => <main>EDIT SCREEN {projectId}</main> }));
vi.mock("./screens/NotificationPreferences", () => ({ NotificationPreferences: () => <main>NOTIFICATIONS SCREEN</main> }));
vi.mock("./screens/SignIn", () => ({ SignIn: () => <main>SIGN IN</main> }));

import App from "./App";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  sessionState.value = { data: { user: { id: "u1", name: "Ada", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

async function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); await Promise.resolve(); await Promise.resolve(); });
  return host;
}

describe("every route kind resolves to its screen through the router", () => {
  it.each([
    ["/", "DASHBOARD SCREEN"],
    ["/?view=list", "DASHBOARD SCREEN"],
    ["/?view=kanban", "DASHBOARD SCREEN"],
    ["/projects/new", "CREATE SCREEN"],
    [`/projects/${projectId}`, `PROJECT SCREEN ${projectId}`],
    [`/projects/${projectId}/edit`, `EDIT SCREEN ${projectId}`],
    ["/admin", "ADMIN SCREEN u1"],
    ["/settings/notifications", "NOTIFICATIONS SCREEN"],
  ])("%s mounts %s", async (path, expected) => {
    const host = await renderAt(path);
    expect(host.textContent).toContain(expected);
  });
});

describe("the parser overrules the router's matcher, and the URL is left alone", () => {
  // Each of these MATCHES a route pattern but parseStaffLocation rejects it. The leaf must render
  // the not-available view rather than its screen, and must not rewrite the location.
  it.each([
    [`/projects/${projectId.toUpperCase()}`, "non-canonical UUID casing"],
    ["/projects/%6eew", "percent-encoded spelling of a static segment"],
    [`/projects/${projectId}/`, "trailing slash"],
    [`/projects/${projectId}/more`, "unknown trailing segment"],
    ["/%61dmin", "percent-encoded spelling of /admin"],
    ["/admin?tab=users", "query on a route whose contract has none"],
    [`/?view=list&detail=${projectId}`, "retired dashboard facet"],
    ["/unknown", "unroutable path"],
  ])("%s renders not-available (%s)", async (path) => {
    const host = await renderAt(path);
    expect(`${window.location.pathname}${window.location.search}`).toBe(path);
    expect(host.textContent).toContain("That page is not available.");
    expect(host.textContent).not.toContain("SCREEN");
  });

  it.each(["/d/token", "/api/projects", "/media/asset/x", "/__transform-source/x"])(
    "%s is reserved and renders not-available without leaving the SPA",
    async (path) => {
      const host = await renderAt(path);
      expect(host.textContent).toContain("That page is not available.");
      expect(`${window.location.pathname}${window.location.search}`).toBe(path);
      // Not-found is rendered inside the application chrome, as it always has been -- the root
      // route's notFoundComponent sits under the same Shell that mounts the Topbar.
      expect(host.querySelector("header")).not.toBeNull();
    },
  );
});

describe("capability redirects still run above the route tree", () => {
  it("sends a photographer away from /admin", async () => {
    sessionState.value = { data: { user: { id: "p1", name: "Pat", role: "photographer" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
    const host = await renderAt("/admin");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
    expect(host.textContent).not.toContain("ADMIN SCREEN");
  });

  it("sends a photographer away from /projects/new", async () => {
    sessionState.value = { data: { user: { id: "p1", name: "Pat", role: "photographer" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
    const host = await renderAt("/projects/new");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
    expect(host.textContent).not.toContain("CREATE SCREEN");
  });
});
