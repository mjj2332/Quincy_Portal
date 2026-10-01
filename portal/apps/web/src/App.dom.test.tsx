import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seenSignals = vi.hoisted(() => [] as Array<number | undefined>);
type MockSessionState = { value: { data: { user: { id: string; name: string; role: string }; session?: { impersonatedBy?: string | null } } | null; isPending: boolean; refetch: () => Promise<void> } };
const sessionState = vi.hoisted(() => ({ value: { data: { user: { id: "u1", name: "Ada", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() } } as MockSessionState));
const stopImpersonatingMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("./lib/auth", () => ({ useSession: () => sessionState.value, stopImpersonating: stopImpersonatingMock, consumeSignInDestination: () => null }));
vi.mock("./lib/stages", () => ({ StagesProvider: ({ children }: { children: unknown }) => children }));
vi.mock("./components/quincy/RailedShell", () => ({ RailedShell: ({ children }: { children: ReactNode }) => <><header />{children}</> }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: ({ calendar }: { calendar?: unknown }) => <main>Dashboard<span data-calendar-route={calendar ? "present" : "absent"} /></main> }));
const ackDuringNextRender = vi.hoisted(() => ({ armed: false }));
vi.mock("./screens/ProjectWorkspace", async () => {
  const { useLayoutEffect } = await import("react");
  return { ProjectWorkspace: ({ projectId, arrivalSignal, arrivalTab, urlTab, onArrivalConsumed, onTabShown }: { projectId: string; arrivalSignal?: number; arrivalTab?: string; urlTab?: string; onArrivalConsumed?: (signal: number) => void; onTabShown?: (tab: string) => void }) => {
    seenSignals.push(arrivalSignal);
    // Acknowledges whatever signal this render received, inside the commit -- before the shell's own
    // passive effect has observed a new location. Models a Workspace that finishes loading then.
    useLayoutEffect(() => {
      if (!ackDuringNextRender.armed) return;
      ackDuringNextRender.armed = false;
      if (arrivalSignal !== undefined) onArrivalConsumed?.(arrivalSignal);
    });
    return <main><button type="button" onClick={() => arrivalSignal !== undefined && onArrivalConsumed?.(arrivalSignal)}>consume {projectId}</button><button type="button" data-show-raw onClick={() => onTabShown?.("raw")}>show raw</button><span data-signal={String(arrivalSignal)} data-arrival-tab={String(arrivalTab)} data-url-tab={String(urlTab)} /></main>;
  } };
});
vi.mock("./screens/SignIn", () => ({ SignIn: () => <main>Sign in</main> }));
vi.mock("./screens/Admin", () => ({ Admin: () => <main>Admin</main> }));
vi.mock("./screens/CreateProject", () => ({ CreateProject: () => <main>Create</main> }));
vi.mock("./screens/EditProject", () => ({ EditProject: () => <main>Edit</main> }));
vi.mock("./lib/query-client", () => ({ QuincyQueryProvider: ({ children, principalId, role }: { children: ReactNode; principalId: string; role: string }) => <div data-query-boundary={`${principalId}:${role}`}>{children}</div> }));

import App from "./App";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  sessionState.value = { data: { user: { id: "u1", name: "Ada", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
});

async function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<App />); await Promise.resolve(); await Promise.resolve(); });
  return host;
}
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); }

afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); seenSignals.splice(0); ackDuringNextRender.armed = false; window.history.replaceState(null, "", "/"); });

describe("App Dashboard route transport", () => {
  it.each([
    "/?view=table",
    "/?view=board",
  ])("preserves a canonical Admin Dashboard route (%s)", async (location) => {
    const host = await renderAt(location);
    expect(`${window.location.pathname}${window.location.search}`).toBe(location);
    expect(host.textContent).toContain("Dashboard");
  });

  it("preserves all Calendar filters", async () => {
    const calendar = "/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist&mine=1&q=smith+street";
    const host = await renderAt(calendar);
    expect(`${window.location.pathname}${window.location.search}`).toBe(calendar);
    expect(host.querySelector("[data-calendar-route]")?.getAttribute("data-calendar-route")).toBe("present");
  });

  it("does not mount Dashboard for a retired project facet", async () => {
    sessionState.value = { data: { user: { id: "photographer", name: "Photographer", role: "photographer" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() };
    const host = await renderAt("/?view=table&detail=123e4567-e89b-42d3-a456-426614174000");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=table&detail=123e4567-e89b-42d3-a456-426614174000");
    expect(host.textContent).toContain("That page is not available.");
    expect(host.querySelector("[data-calendar-route]")).toBeNull();
  });

  it("does not mount Dashboard for the retired kanban2 view (#83)", async () => {
    const host = await renderAt("/?view=kanban2");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=kanban2");
    expect(host.textContent).toContain("That page is not available.");
    expect(host.querySelector("[data-calendar-route]")).toBeNull();
  });

  it("does not navigate away from a plain Calendar route", async () => {
    const plain = "/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist";
    await renderAt(plain);
    expect(`${window.location.pathname}${window.location.search}`).toBe(plain);
  });

  it("keeps explicit Dashboard routes stable on Back/Forward arrivals", async () => {
    const host = await renderAt("/");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
    for (const facet of ["/?view=board", "/?view=table", "/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist"]) {
      await act(async () => { window.history.replaceState(null, "", facet); window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
      expect(`${window.location.pathname}${window.location.search}`).toBe(facet);
    }
    expect(host.textContent).toContain("Dashboard");
  });

  it("does not mount Dashboard for a retired kanban2 view arriving via Back/Forward (#83)", async () => {
    const host = await renderAt("/");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
    await act(async () => { window.history.replaceState(null, "", "/?view=kanban2"); window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=kanban2");
    expect(host.textContent).toContain("That page is not available.");
  });

  it("renders the Dashboard for a valid Calendar root location", async () => {
    const host = await renderAt("/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist");
    expect(host.textContent).toContain("Dashboard");
    expect(host.querySelector("[data-calendar-route]")?.getAttribute("data-calendar-route")).toBe("present");
  });

  it("replaces a withheld Photographer Calendar location without mounting Calendar state", async () => {
    sessionState.value = { data: { user: { id: "photographer", name: "Photographer", role: "photographer" } }, isPending: false, refetch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
    const host = await renderAt("/?view=calendar&date=2026-08-30&sub=agenda&layers=project%2Cchecklist");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/");
    expect(host.querySelector("[data-calendar-route]")?.getAttribute("data-calendar-route")).toBe("absent");
  });

  // #366: the Project stub renders inside the Project sheet, which portals to <body>, not into `host`.
  const sheetBody = () => document.querySelector<HTMLElement>('[data-testid="project-sheet-body"]')!;
  const here = () => `${window.location.pathname}${window.location.search}`;
  const consumeButton = (host: Element) => host.querySelector<HTMLButtonElement>("button:not([data-show-raw])")!;
  const showRawButton = (host: Element) => host.querySelector<HTMLButtonElement>("button[data-show-raw]")!;
  const arriveByHistory = (location: string) => act(async () => { window.history.pushState(null, "", location); window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });

  it("#367: keeps the tab in the URL after an arrival is acknowledged, and observes a later identical history arrival as a fresh signal", async () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const host = await renderAt(`/projects/${projectId}?collaboration=open`);
    expect(sheetBody().querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("1");
    await click(consumeButton(sheetBody()));
    expect(here()).toBe(`/projects/${projectId}?collaboration=open`);
    expect(sheetBody().querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("undefined");
    expect(sheetBody().querySelector("[data-signal]")?.getAttribute("data-url-tab")).toBe("collaboration");
    await arriveByHistory(`/projects/${projectId}?collaboration=open`);
    expect(sheetBody().querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("2");
    await click(consumeButton(sheetBody()));
    expect(here()).toBe(`/projects/${projectId}?collaboration=open`);
  });

  it("#367: hands a Collection tab arrival to the Workspace once and leaves the tab in the URL", async () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const host = await renderAt(`/projects/${projectId}?tab=edited`);
    const marker = () => sheetBody().querySelector("[data-signal]")!;
    expect(marker().getAttribute("data-signal")).toBe("1");
    expect(marker().getAttribute("data-arrival-tab")).toBe("edited");
    expect(marker().getAttribute("data-url-tab")).toBe("edited");
    await click(consumeButton(sheetBody()));
    expect(here()).toBe(`/projects/${projectId}?tab=edited`);
    expect(marker().getAttribute("data-signal")).toBe("undefined");

    // A different tab's arrival on the same Project is a fresh signal carrying its own tab...
    await arriveByHistory(`/projects/${projectId}?tab=raw`);
    expect(marker().getAttribute("data-signal")).toBe("2");
    expect(marker().getAttribute("data-arrival-tab")).toBe("raw");
    // ...and so is switching straight to the Collaboration spelling before the first is acknowledged.
    await arriveByHistory(`/projects/${projectId}?collaboration=open`);
    expect(marker().getAttribute("data-signal")).toBe("3");
    expect(marker().getAttribute("data-arrival-tab")).toBe("collaboration");
    await click(consumeButton(sheetBody()));
    expect(here()).toBe(`/projects/${projectId}?collaboration=open`);
  });

  it("#367: the Workspace's own tab write replaces the URL without a history entry or a new arrival signal", async () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const host = await renderAt(`/projects/${projectId}?tab=edited`);
    await click(consumeButton(sheetBody()));
    const before = window.history.length;
    const signalsBefore = seenSignals.filter((signal): signal is number => signal !== undefined);
    await click(showRawButton(sheetBody()));
    expect(here()).toBe(`/projects/${projectId}?tab=raw`);
    expect(window.history.length).toBe(before);
    expect(sheetBody().querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("undefined");
    expect(sheetBody().querySelector("[data-signal]")?.getAttribute("data-url-tab")).toBe("raw");
    const signalsAfter = seenSignals.filter((signal): signal is number => signal !== undefined);
    expect(signalsAfter.filter((signal) => !signalsBefore.includes(signal))).toEqual([]);
  });

  it("#367: Back after tab switches leaves the Project in one step", async () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const host = await renderAt("/");
    await arriveByHistory(`/projects/${projectId}?collaboration=open`);
    await click(consumeButton(sheetBody()));
    await click(showRawButton(sheetBody()));
    expect(here()).toBe(`/projects/${projectId}?tab=raw`);
    await act(async () => { window.history.replaceState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Dashboard");
  });

  it("#367: a stale arrival's acknowledgement never changes the URL or a newer arrival's tab", async () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const host = await renderAt(`/projects/${projectId}?tab=raw`);
    expect(sheetBody().querySelector("[data-signal]")!.getAttribute("data-arrival-tab")).toBe("raw");
    // The Raw arrival is still unconsumed when an Edited notification for the same Project is clicked;
    // the Workspace acknowledges during the very commit that renders the new location.
    ackDuringNextRender.armed = true;
    await arriveByHistory(`/projects/${projectId}?tab=edited`);
    expect(ackDuringNextRender.armed).toBe(false);
    expect(here()).toBe(`/projects/${projectId}?tab=edited`);
    const marker = sheetBody().querySelector("[data-signal]")!;
    expect(marker.getAttribute("data-arrival-tab")).toBe("edited");
    expect(marker.getAttribute("data-signal")).toBe("2");
    await click(consumeButton(sheetBody()));
    expect(here()).toBe(`/projects/${projectId}?tab=edited`);
  });

  it("drops an acknowledged signal before navigating away so a clean-route remount stays collapsed", async () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const host = await renderAt(`/projects/${projectId}?collaboration=open`);
    expect(sheetBody().querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("1");
    await click(consumeButton(sheetBody()));
    // #367: an acknowledged arrival no longer strips the tab from the URL.
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/projects/${projectId}?collaboration=open`);

    await act(async () => {
      window.history.pushState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host.textContent).toContain("Dashboard");
    await act(async () => {
      window.history.pushState(null, "", `/projects/${projectId}`); window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(sheetBody().querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("undefined");
    expect(seenSignals.at(-1)).toBeUndefined();
  });
});

describe("App impersonation boundary", () => {
  it("renders the target identity banner above staff routes and does not expose Admin navigation", async () => {
    sessionState.value = { data: { user: { id: "target", name: "Editor Target", role: "editor" }, session: { impersonatedBy: "u1" } }, isPending: false, refetch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
    const host = await renderAt("/");
    expect(host.textContent).toContain("Acting as Editor Target (Editor) · Exit");
    expect(host.textContent).toContain("Dashboard");
    expect(host.querySelector("[data-query-boundary]")?.getAttribute("data-query-boundary")).toBe("target:editor");
    expect(host.textContent).not.toContain("Admin");

    await act(async () => { window.history.pushState(null, "", "/projects/123e4567-e89b-42d3-a456-426614174000"); window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain("Acting as Editor Target (Editor) · Exit");
    expect(document.querySelector('[data-testid="project-sheet-body"]')?.textContent).toContain("consume 123e4567-e89b-42d3-a456-426614174000");
  });

  it("isolates a promoted target before the provider and preserves the Exit banner", async () => {
    sessionState.value = { data: { user: { id: "target", name: "Promoted Target", role: "admin" }, session: { impersonatedBy: "u1" } }, isPending: false, refetch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
    const host = await renderAt("/admin");
    expect(host.textContent).toContain("Acting as Promoted Target (Admin) · Exit");
    expect(host.textContent).toContain("This impersonated session is no longer valid — exit to restore your Admin session.");
    expect(host.querySelector("header")).toBeNull();
    expect(host.textContent).not.toContain("Dashboard");
  });
});
