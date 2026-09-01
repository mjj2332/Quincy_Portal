import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectActivityView } from "./ProjectActivityView";
import { ApiError } from "../lib/api";

const queryState = vi.hoisted(() => ({ role: "editor" as string, value: undefined as unknown }));
const useProjectActivityQueryMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { role: queryState.role } } }) }));
vi.mock("../lib/project-activity", () => ({ useProjectActivityQuery: useProjectActivityQueryMock }));

const refetch = vi.fn(() => Promise.resolve());
const fetchNextPage = vi.fn(() => Promise.resolve());
const internalPage = {
  pages: [{ items: [
    { id: "activity-1", type: "project.details.changed", category: "project_metadata", occurredAt: 1_756_675_200_000, presentation: { title: "Details changed", body: "The project details changed." }, actor: { id: "user-1", name: "Eli Editor" } },
    { id: "activity-2", type: "project.collection.raw_sync_completed", category: "collection", occurredAt: 1_756_675_260_000, presentation: { title: "RAW sync completed", body: "RAW files are ready." }, actor: null },
  ], nextCursor: "older" }], pageParams: [null],
};
const externalPage = { pages: [{ items: [{ id: "activity-external", type: "project.collection.raw_sync_completed", category: "collection", occurredAt: 1_756_675_200_000, presentation: { title: "RAW sync completed", body: "The external delivery is ready." } }], nextCursor: null }], pageParams: [null] };

let root: Root;
let host: HTMLElement;

function state(overrides: Record<string, unknown> = {}) {
  return { data: queryState.value, isPending: false, isError: false, error: null, fetchStatus: "idle", isFetching: false, isFetchingNextPage: false, hasNextPage: false, refetch, fetchNextPage, ...overrides };
}

function render(enabled = true) {
  act(() => { root.render(<ProjectActivityView projectId="project-1" enabled={enabled} />); });
}

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  queryState.role = "editor"; queryState.value = undefined; refetch.mockClear(); fetchNextPage.mockClear();
  useProjectActivityQueryMock.mockReset().mockReturnValue(state({ isPending: true }));
});

afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });

describe("ProjectActivityView", () => {
  it("renders loading, then activity data, timestamps, system actors, and pagination", () => {
    render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading activity.");

    queryState.value = internalPage;
    useProjectActivityQueryMock.mockReturnValue(state({ data: internalPage, hasNextPage: true }));
    render();
    expect(host.textContent).toContain("Details changed");
    expect(host.textContent).toContain("Eli Editor");
    expect(host.textContent).toContain("System");
    expect(host.querySelectorAll("time")).toHaveLength(2);
    act(() => { host.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });

  it("shows an error and refetches when Retry is clicked", () => {
    useProjectActivityQueryMock.mockReturnValue(state({ isError: true, error: new Error("Offline") }));
    render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Offline");
    act(() => { host.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows the error and Retry when an empty cached page refetch fails", () => {
    const emptyPage = { pages: [{ items: [], nextCursor: null }], pageParams: [null] };
    useProjectActivityQueryMock.mockReturnValue(state({ data: emptyPage, isError: true, error: new Error("Offline") }));
    render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Offline");
    expect(host.querySelector("button")?.textContent).toBe("Retry");
    expect(host.textContent).not.toContain("No activity yet.");
  });

  it.each([403, 404] as const)("renders a permanent %i denial without Retry or the raw server message", (status) => {
    const error = new ApiError("Sensitive project access detail", status);
    useProjectActivityQueryMock.mockReturnValue(state({ isError: true, error }));
    render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Project activity isn't available for this project at its current stage.");
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("Sensitive project access detail");
    expect(host.querySelector("button")).toBeNull();
  });

  it("renders a non-loading disabled state when activity is gated off", () => {
    useProjectActivityQueryMock.mockReturnValue(state({ isPending: true, fetchStatus: "idle" }));
    render(false);
    expect(host.textContent).toContain("Activity is not available in this view.");
    expect(host.textContent).not.toContain("Loading activity.");
  });

  it("renders an empty state", () => {
    queryState.value = { pages: [{ items: [], nextCursor: null }], pageParams: [null] };
    useProjectActivityQueryMock.mockReturnValue(state({ data: queryState.value }));
    render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("No activity yet.");
  });

  it("keeps External Activity actor-free and does not crash on the strict External shape", () => {
    queryState.role = "external_editor"; queryState.value = externalPage;
    useProjectActivityQueryMock.mockReturnValue(state({ data: externalPage }));
    render();
    expect(host.textContent).toContain("RAW sync completed");
    expect(host.textContent).not.toContain("Eli Editor");
    expect(host.querySelector(".project-activity-view__actor")).toBeNull();
  });

  it("suppresses actor names through the External component guard", () => {
    queryState.role = "external_editor"; queryState.value = internalPage;
    useProjectActivityQueryMock.mockReturnValue(state({ data: internalPage }));
    render();
    expect(host.textContent).toContain("Details changed");
    expect(host.textContent).not.toContain("Eli Editor");
    expect(host.querySelector(".project-activity-view__actor")).toBeNull();
  });
});
