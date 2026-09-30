import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectActivityView } from "./ProjectActivityView";
import { ApiError } from "../lib/api";
import type { Job } from "../lib/project-jobs";

const queryState = vi.hoisted(() => ({ role: "editor" as string, value: undefined as unknown }));
const useProjectActivityQueryMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { role: queryState.role } } }) }));
vi.mock("../lib/project-activity", () => ({ useProjectActivityQuery: useProjectActivityQueryMock }));

const refetch = vi.fn(() => Promise.resolve());
const fetchNextPage = vi.fn(() => Promise.resolve());
const internalPage = {
  pages: [{ items: [
    { id: "activity-1", type: "project.details.changed", category: "project_metadata", occurredAt: 1_756_675_200_000, presentation: { title: "Details changed", body: "Maple House details were updated." }, actor: { id: "user-1", name: "Eli Editor" } },
    { id: "activity-2", type: "project.collection.raw_sync_completed", category: "collection", occurredAt: 1_756_675_260_000, presentation: { title: "RAW sync completed", body: "RAW files are ready." }, actor: null },
  ], nextCursor: "older" }], pageParams: [null],
};
const externalPage = { pages: [{ items: [{ id: "activity-external", type: "project.collection.raw_sync_completed", category: "collection", occurredAt: 1_756_675_200_000, presentation: { title: "RAW sync completed", body: "The external delivery is ready." } }], nextCursor: null }], pageParams: [null] };

let root: Root;
let host: HTMLElement;

function state(overrides: Record<string, unknown> = {}) {
  return { data: queryState.value, isPending: false, isError: false, error: null, fetchStatus: "idle", isFetching: false, isFetchingNextPage: false, hasNextPage: false, refetch, fetchNextPage, ...overrides };
}

type ViewProps = Partial<React.ComponentProps<typeof ProjectActivityView>>;
function render(enabled = true, props: ViewProps = {}) {
  act(() => { root.render(<ProjectActivityView projectId="project-1" enabled={enabled} {...props} />); });
}
const byName = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name);
const rowsOf = () => [...host.querySelectorAll("li")];
const headings = () => [...host.querySelectorAll("h3")].map((heading) => heading.textContent);
const NOW = Date.parse("2026-09-30T02:00:00Z"); // 12:00 Sydney (AEST, +10 before DST starts 4 Oct)
const item = (id: string, occurredAt: number, body = `${id} body`, actor: { id: string; name: string } | null = { id: "user-1", name: "Eli Editor" }) => ({ id, type: "project.details.changed", category: "project_metadata", occurredAt, presentation: { title: `${id} title`, body }, actor });
const feedPage = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });
const feed = (...pages: unknown[]) => ({ pages, pageParams: pages.map(() => null) });
const job = (overrides: Partial<Job> = {}): Job => ({ id: "job-1", kind: "fetch_edited", status: "done", error: null, correlationId: null, createdAt: "2026-09-30T01:00:00.000Z", updatedAt: "2026-09-30T01:00:00.000Z", ...overrides });

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  queryState.role = "editor"; queryState.value = undefined; refetch.mockClear(); fetchNextPage.mockClear();
  useProjectActivityQueryMock.mockReset().mockReturnValue(state({ isPending: true }));
});

afterEach(() => { vi.useRealTimers(); act(() => root.unmount()); document.body.replaceChildren(); });

describe("ProjectActivityView", () => {
  it("renders loading, then activity data, timestamps, actor-less rows without a System label, and pagination", () => {
    render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading activity.");

    queryState.value = internalPage;
    useProjectActivityQueryMock.mockReturnValue(state({ data: internalPage, hasNextPage: true }));
    render();
    expect(host.textContent).toContain("Maple House details were updated.");
    expect(host.textContent).toContain("Eli Editor");
    expect(host.textContent).not.toContain("System");
    expect(host.querySelectorAll("time")).toHaveLength(2);
    act(() => { byName("Load more activity")!.click(); });
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });

  it("shows a bare clock time for a row under its own day heading, and a relative time only today", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const data = feed(feedPage([item("a", Date.parse("2026-09-30T01:30:00Z")), item("b", Date.parse("2026-09-29T03:04:00Z"))]));
    useProjectActivityQueryMock.mockReturnValue(state({ data }));
    render();
    const times = [...host.querySelectorAll("time")].map((time) => time.textContent);
    expect(times).toEqual(["30m ago", "1:04 PM"]);
  });

  it("shows an error and refetches when Retry is clicked", () => {
    useProjectActivityQueryMock.mockReturnValue(state({ isError: true, error: new Error("Offline") }));
    render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Offline");
    act(() => { byName("Retry")!.click(); });
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows the error and Retry when an empty cached page refetch fails", () => {
    const emptyPage = { pages: [{ items: [], nextCursor: null }], pageParams: [null] };
    useProjectActivityQueryMock.mockReturnValue(state({ data: emptyPage, isError: true, error: new Error("Offline") }));
    render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Offline");
    expect(byName("Retry")).toBeDefined();
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
    expect(host.textContent).toContain("The external delivery is ready.");
    expect(host.textContent).not.toContain("Eli Editor");
    expect(host.querySelector('[data-testid="initials-avatar"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-activity-actor"]')).toBeNull();
  });

  it("suppresses actor names through the External component guard", () => {
    queryState.role = "external_editor"; queryState.value = internalPage;
    useProjectActivityQueryMock.mockReturnValue(state({ data: internalPage }));
    render();
    expect(host.textContent).toContain("Maple House details were updated.");
    expect(host.textContent).not.toContain("Eli Editor");
    expect(host.querySelector('[data-testid="project-activity-actor"]')).toBeNull();
    expect(host.querySelector('[data-testid="initials-avatar"]')).toBeNull();
  });

  describe("grouped by Sydney day (#378)", () => {
    it("groups newest-first under Today / Yesterday / a dated heading", () => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const data = feed(feedPage([
        item("today", Date.parse("2026-09-30T01:00:00Z")),
        item("yesterday", Date.parse("2026-09-29T01:00:00Z")),
        item("old", Date.parse("2026-09-12T01:00:00Z")),
      ]));
      useProjectActivityQueryMock.mockReturnValue(state({ data }));
      render();
      expect(headings()).toEqual(["Today", "Yesterday", "12 Sep 2026"]);
      expect(rowsOf()).toHaveLength(3);
    });

    it("splits buckets on the Sydney day, not the UTC day (AEST, 13:30Z vs 14:30Z)", () => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-06-12T02:00:00Z") });
      const data = feed(feedPage([item("late", Date.parse("2026-06-10T14:30:00Z")), item("early", Date.parse("2026-06-10T13:30:00Z"))]));
      useProjectActivityQueryMock.mockReturnValue(state({ data }));
      render();
      expect(headings()).toEqual(["Yesterday", "10 Jun 2026"]);
    });

    it("keeps one heading for a day that spans a Load-more page boundary, and one row per id", () => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const data = feed(
        feedPage([item("p1", Date.parse("2026-09-29T05:00:00Z"))], "older"),
        feedPage([item("p1", Date.parse("2026-09-29T05:00:00Z")), item("p2", Date.parse("2026-09-29T01:00:00Z"))]),
      );
      useProjectActivityQueryMock.mockReturnValue(state({ data }));
      render();
      expect(headings()).toEqual(["Yesterday"]);
      expect(rowsOf()).toHaveLength(2);
    });

    it("renders the actor once, bold, then the sentence; no left rule; no System label for a null actor", () => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const data = feed(feedPage([item("a", Date.parse("2026-09-30T01:00:00Z"), "Checklist “Tiff Video” was updated."), item("b", Date.parse("2026-09-30T00:00:00Z"), "RAW files are ready.", null)]));
      useProjectActivityQueryMock.mockReturnValue(state({ data }));
      render();
      const [first, second] = rowsOf();
      expect(first!.textContent!.split("Eli Editor")).toHaveLength(2);
      expect(first!.querySelector("strong")?.textContent).toBe("Eli Editor");
      expect(first!.textContent).toContain("Checklist “Tiff Video” was updated.");
      expect(first!.textContent).not.toContain("a title");
      expect(first!.querySelector('[data-testid="initials-avatar"]')).not.toBeNull();
      expect(second!.textContent).toContain("RAW files are ready.");
      expect(second!.textContent).not.toContain("System");
      expect(second!.querySelector("strong")).toBeNull();
      expect(second!.querySelector('[data-testid="initials-avatar"]')).toBeNull();
      expect(host.innerHTML).not.toMatch(/border-l-/);
    });
  });

  describe("Project | System source (#378)", () => {
    const jobs = [
      job({ id: "j-failed", kind: "fetch_edited", status: "failed", error: "Dropbox refused the folder", createdAt: "2026-09-30T01:00:00.000Z" }),
      job({ id: "j-api", kind: "autohdr_api_send", status: "failed", createdAt: "2026-09-30T00:30:00.000Z" }),
      job({ id: "j-done", kind: "manual_raw_publish", status: "done", createdAt: "2026-09-29T01:00:00.000Z" }),
    ];
    const setup = (props: ViewProps = {}) => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const data = feed(feedPage([item("a", Date.parse("2026-09-30T01:00:00Z"), "Feed sentence.")], "older"));
      useProjectActivityQueryMock.mockReturnValue(state({ data, hasNextPage: true }));
      render(true, { jobs, onRetryJob: vi.fn(), ...props });
    };
    const group = () => host.querySelector('[role="group"][aria-label="Activity source"]');

    it("offers no source group without jobs (non-admin)", () => {
      setup({ jobs: undefined });
      expect(group()).toBeNull();
      expect(host.textContent).toContain("Feed sentence.");
    });

    it("starts on Project (aria-pressed) with no job rows, then System swaps the view and back", () => {
      setup();
      expect(group()).not.toBeNull();
      expect(byName("Project")!.getAttribute("aria-pressed")).toBe("true");
      expect(byName("System")!.getAttribute("aria-pressed")).toBe("false");
      expect(host.textContent).not.toContain("Dropbox refused the folder");

      act(() => { byName("System")!.click(); });
      expect(byName("System")!.getAttribute("aria-pressed")).toBe("true");
      expect(host.textContent).toContain("Dropbox refused the folder");
      expect(host.textContent).toContain("Fetch");
      expect(host.textContent).toContain("API send");
      expect(host.textContent).toContain("Manual upload");
      expect(host.textContent).toContain("failed");
      expect(host.textContent).not.toContain("Feed sentence.");
      expect(byName("Load more activity")).toBeUndefined();
      expect(headings()).toEqual(["Today", "Yesterday"]);

      act(() => { byName("Project")!.click(); });
      expect(host.textContent).toContain("Feed sentence.");
      expect(host.textContent).not.toContain("Dropbox refused the folder");
      expect(byName("Load more activity")).toBeDefined();
    });

    it("offers Retry only on a failed or stuck job that is not an API send, and calls onRetryJob(id)", () => {
      const onRetryJob = vi.fn();
      setup({ onRetryJob });
      act(() => { byName("System")!.click(); });
      const retries = [...host.querySelectorAll("button")].filter((button) => button.textContent === "Retry");
      expect(retries).toHaveLength(1);
      act(() => { retries[0]!.click(); });
      expect(onRetryJob).toHaveBeenCalledWith("j-failed");
    });

    it("shows a compact empty line for no jobs", () => {
      setup({ jobs: [] });
      act(() => { byName("System")!.click(); });
      expect(host.textContent).toContain("No background jobs yet.");
    });

    it("is controllable: honours source and reports changes", () => {
      const onSourceChange = vi.fn();
      setup({ source: "system", onSourceChange });
      expect(byName("System")!.getAttribute("aria-pressed")).toBe("true");
      act(() => { byName("Project")!.click(); });
      expect(onSourceChange).toHaveBeenCalledWith("project");
    });
  });
});
