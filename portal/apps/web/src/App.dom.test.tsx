import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const seenSignals = vi.hoisted(() => [] as Array<number | undefined>);
type MockSessionState = { value: { data: { user: { id: string; name: string; role: string }; session?: { impersonatedBy?: string | null } } | null; isPending: boolean; refetch: () => Promise<void> } };
const sessionState = vi.hoisted(() => ({ value: { data: { user: { id: "u1", name: "Ada", role: "admin" } }, isPending: false, refetch: vi.fn<() => Promise<void>>() } } as MockSessionState));
const stopImpersonatingMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("./lib/auth", () => ({ useSession: () => sessionState.value, stopImpersonating: stopImpersonatingMock, consumeSignInDestination: () => null }));
vi.mock("./lib/stages", () => ({ StagesProvider: ({ children }: { children: unknown }) => children }));
vi.mock("./components/Topbar", () => ({ Topbar: () => <header /> }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: () => <main>Dashboard</main> }));
vi.mock("./screens/ProjectWorkspace", () => ({ ProjectWorkspace: ({ projectId, collaborationOpenSignal, onCollaborationOpenSignalConsumed }: { projectId: string; collaborationOpenSignal?: number; onCollaborationOpenSignalConsumed?: (signal: number) => void }) => { seenSignals.push(collaborationOpenSignal); return <main><button type="button" onClick={() => collaborationOpenSignal !== undefined && onCollaborationOpenSignalConsumed?.(collaborationOpenSignal)}>consume {projectId}</button><span data-signal={String(collaborationOpenSignal)} /></main>; } }));
vi.mock("./screens/SignIn", () => ({ SignIn: () => <main>Sign in</main> }));
vi.mock("./screens/Admin", () => ({ Admin: () => <main>Admin</main> }));
vi.mock("./screens/CreateProject", () => ({ CreateProject: () => <main>Create</main> }));
vi.mock("./screens/EditProject", () => ({ EditProject: () => <main>Edit</main> }));
vi.mock("./lib/query-client", () => ({ QuincyQueryProvider: ({ children, principalId, role }: { children: ReactNode; principalId: string; role: string }) => <div data-query-boundary={`${principalId}:${role}`}>{children}</div> }));

import App from "./App";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<App />); await Promise.resolve(); await Promise.resolve(); });
  return host;
}
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); }

afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); seenSignals.splice(0); window.history.replaceState(null, "", "/"); });

describe("App collaboration arrival transport", () => {
  it("cleans each acknowledged intent and observes a later identical history arrival as a fresh signal", async () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const host = await renderAt(`/projects/${projectId}?collaboration=open`);
    expect(host.querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("1");
    await click(host.querySelector("button")!);
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/projects/${projectId}`);
    await act(async () => { window.history.pushState(null, "", `/projects/${projectId}?collaboration=open`); window.dispatchEvent(new PopStateEvent("popstate")); await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("2");
    await click(host.querySelector("button")!);
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/projects/${projectId}`);
  });

  it("drops an acknowledged signal before navigating away so a clean-route remount stays collapsed", async () => {
    const projectId = "123e4567-e89b-42d3-a456-426614174000";
    const host = await renderAt(`/projects/${projectId}?collaboration=open`);
    expect(host.querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("1");
    await click(host.querySelector("button")!);
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/projects/${projectId}`);

    await act(async () => {
      window.history.pushState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host.textContent).toContain("Dashboard");
    await act(async () => {
      window.history.pushState(null, "", `/projects/${projectId}`); window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host.querySelector("[data-signal]")?.getAttribute("data-signal")).toBe("undefined");
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
    expect(host.textContent).toContain("consume 123e4567-e89b-42d3-a456-426614174000");
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
