import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rail, mounted by the real shell — #111, AC7 and AC8.
 *
 * A separate file from `App.dom.test.tsx` because that file may not be edited, and because it
 * mocks the shell chrome away — this one needs the real chrome to check what mounts.
 *
 * Calendar's URL canonicalisation is deliberately NOT re-asserted here — the Dashboard owns it and
 * `screens/Dashboard-calendar-intent.dom.test.tsx` proves it with the real screen. This file mocks
 * the screens away, so what it can prove is the half that belongs to the shell: the rail links at
 * the bare intent URL, and the shell accepts that URL and mounts the Dashboard rather than
 * not-found.
 */

const sessionState = vi.hoisted(() => ({
  value: {
    data: { user: { id: "u1", name: "Ada Lovelace", role: "admin" } },
    isPending: false,
    refetch: vi.fn<() => Promise<void>>(),
  },
}));

vi.mock("./lib/auth", () => ({
  useSession: () => sessionState.value,
  stopImpersonating: vi.fn<() => Promise<void>>(),
  consumeSignInDestination: () => null,
  signOut: vi.fn<() => Promise<void>>(),
}));
// The rail mounts the real NotificationBell, which polls the notifications endpoint. Without this
// the poll reaches the network and fills the run with ECONNREFUSED noise.
vi.mock("./lib/api", () => ({
  apiGet: vi.fn(async () => ({ notifications: [], unreadCount: 0 })),
  apiPost: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
}));
vi.mock("./lib/stages", () => ({ StagesProvider: ({ children }: { children: unknown }) => children }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: () => <main>Dashboard</main> }));
vi.mock("./screens/ProjectWorkspace", () => ({ ProjectWorkspace: () => <main>Project</main> }));
vi.mock("./screens/SignIn", () => ({ SignIn: () => <main>Sign in</main> }));
vi.mock("./screens/Admin", () => ({ Admin: () => <main>Admin</main> }));
vi.mock("./screens/CreateProject", () => ({ CreateProject: () => <main>Create</main> }));
vi.mock("./screens/EditProject", () => ({ EditProject: () => <main>Edit</main> }));
vi.mock("./lib/query-client", () => ({
  QuincyQueryProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import App from "./App";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  sessionState.value = {
    data: { user: { id: "u1", name: "Ada Lovelace", role: "admin" } },
    isPending: false,
    refetch: vi.fn<() => Promise<void>>(),
  };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.unstubAllEnvs();
});

async function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the navigation rail", () => {
  it("mounts the rail unconditionally", async () => {
    const host = await renderAt("/");
    expect(host.querySelector('[data-testid="navigation-rail"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="topbar-identity"]')).toBeNull();
    // The row-layout class is deliberately NOT asserted here. `testing/test-seam.guard.test.ts`
    // guards A and C make selecting on, or asserting the presence of, a Quincy class name in a DOM
    // test a build failure — and they are right that a class name is not behaviour. The rule that
    // class depends on is asserted at its own seam instead, in `styles/app-railed.test.ts`.
  });

  it("navigates to every destination the rail offers (AC7)", async () => {
    const host = await renderAt("/");

    const destinations = [
      ...host.querySelectorAll(
        '[data-testid="navigation-rail-link"], [data-testid="navigation-rail-child-link"]',
      ),
    ].map((element) => element.getAttribute("href")!);
    expect(destinations).toEqual(["/", "/?view=list", "/?view=kanban", "/?view=calendar", "/admin"]);

    for (const href of destinations) {
      await renderAt("/");
      const link = host.ownerDocument.querySelector(`[href="${href}"]`)!;
      await click(link);
      expect(`${window.location.pathname}${window.location.search}`, href).toBe(href);
      // Proves the click went through `InternalLink`/`locationStore` rather than being swallowed:
      // a route the shell rejects renders the not-available view instead of a screen.
      expect(document.body.textContent).not.toContain("That page is not available.");
      if (root) await act(async () => root!.unmount());
      root = null;
      document.body.replaceChildren();
    }
  });

  it("reaches the Calendar through the bare intent URL, not a facet the rail composed", async () => {
    const host = await renderAt("/");
    const calendar = [
      ...host.querySelectorAll('[data-testid="navigation-rail-child-link"]'),
    ].find((element) => element.textContent?.trim() === "Calendar")!;

    expect(calendar.getAttribute("href")).toBe("/?view=calendar");
    await click(calendar);
    // The shell accepts the intent and mounts the Dashboard. The rewrite to the full facet URL is
    // the Dashboard's own job, mocked out here and covered by its own DOM test.
    expect(host.textContent).toContain("Dashboard");
    expect(host.textContent).not.toContain("That page is not available.");
  });

  it("hides Admin from a role without the capability", async () => {
    sessionState.value = {
      data: { user: { id: "p1", name: "Photographer", role: "photographer" } },
      isPending: false,
      refetch: vi.fn<() => Promise<void>>(),
    };
    const host = await renderAt("/");
    const labels = [
      ...host.querySelectorAll('[data-testid="navigation-rail-link"]'),
    ].map((element) => element.textContent?.trim());
    expect(labels).toEqual(["Dashboard"]);
  });
});
