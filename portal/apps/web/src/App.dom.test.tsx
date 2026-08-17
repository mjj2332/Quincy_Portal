import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const seenSignals = vi.hoisted(() => [] as Array<number | undefined>);
vi.mock("./lib/auth", () => ({ useSession: () => ({ data: { user: { id: "u1", name: "Ada", role: "admin" } }, isPending: false }), consumeSignInDestination: () => null }));
vi.mock("./lib/stages", () => ({ StagesProvider: ({ children }: { children: unknown }) => children }));
vi.mock("./components/Topbar", () => ({ Topbar: () => <header /> }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: () => <main>Dashboard</main> }));
vi.mock("./screens/ProjectWorkspace", () => ({ ProjectWorkspace: ({ projectId, collaborationOpenSignal, onCollaborationOpenSignalConsumed }: { projectId: string; collaborationOpenSignal?: number; onCollaborationOpenSignalConsumed?: (signal: number) => void }) => { seenSignals.push(collaborationOpenSignal); return <main><button type="button" onClick={() => collaborationOpenSignal !== undefined && onCollaborationOpenSignalConsumed?.(collaborationOpenSignal)}>consume {projectId}</button><span data-signal={String(collaborationOpenSignal)} /></main>; } }));
vi.mock("./screens/SignIn", () => ({ SignIn: () => <main>Sign in</main> }));
vi.mock("./screens/Admin", () => ({ Admin: () => <main>Admin</main> }));
vi.mock("./screens/CreateProject", () => ({ CreateProject: () => <main>Create</main> }));
vi.mock("./screens/EditProject", () => ({ EditProject: () => <main>Edit</main> }));

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
