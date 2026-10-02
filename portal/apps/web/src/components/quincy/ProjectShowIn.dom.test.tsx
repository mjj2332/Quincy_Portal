/**
 * #464 — the Project sheet's "Show in Calendar / Timeline" button group. Query by role, name and
 * test id only. UUID fixtures (lesson #431).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectShowIn } from "./ProjectShowIn";
import { projectDataKeys, type ProjectDetail } from "../../lib/project-data";
import { locationStore } from "../../lib/router";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = "7f3b9c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const roleState = vi.hoisted(() => ({ role: "editor" as "admin" | "editor" | "photographer" | "external_editor" }));
vi.mock("../../lib/capabilities", () => ({
  useCapabilities: () => ({ role: roleState.role, capabilities: [], can: (capability: string) => capability === "viewProductionCalendar" && roleState.role !== "photographer" }),
}));

function project(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: ID, street: "12 Example St", suburb: "Suburbia", postcode: "2000", agencyName: null, agentName: null,
    shootDate: null, stageKey: "editing", rawFolderPath: null, rawFolderLink: null, boardRevision: 5, contractEnabled: true,
    coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [],
    deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
    ...overrides,
  } as ProjectDetail;
}
const withDeadline = { version: 1, deadline: { localCivil: "2026-10-09T17:00", zone: "Australia/Sydney", utcOffsetMinutes: 660, fold: 0, instant: "2026-10-09T06:00:00Z" }, reminderOffsetsMinutes: [], state: "scheduled", nextOccurrence: null, canResume: false } as ProjectDetail["deadlineSchedule"];

let root: Root; let host: HTMLElement; let client: QueryClient;
const calendar = () => host.querySelector<HTMLElement>('[data-testid="project-show-in-calendar"]');
const timeline = () => host.querySelector<HTMLElement>('[data-testid="project-show-in-timeline"]');
async function mount(value: ProjectDetail) {
  await act(async () => { root.render(<QueryClientProvider client={client}><ProjectShowIn project={value} /></QueryClientProvider>); await Promise.resolve(); });
}

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient(); roleState.role = "editor"; });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("ProjectShowIn (#464)", () => {
  it("renders nothing for a Photographer", async () => {
    roleState.role = "photographer";
    await mount(project({ deadlineSchedule: withDeadline }));
    expect(host.querySelector('[data-testid="project-show-in"]')).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("is a two-button group of links named Show in Calendar and Show in Timeline, with focus hrefs", async () => {
    await mount(project({ deadlineSchedule: withDeadline }));
    const group = host.querySelector('[role="group"][aria-label="Show in"]');
    expect(group).not.toBeNull();
    const links = [...group!.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["Show in Calendar", "Show in Timeline"]);
    expect(links.every((link) => link.getAttribute("role") === "link")).toBe(true);
    expect(links[0]!.getAttribute("href")).toMatch(new RegExp(`^/\\?view=calendar&date=2026-10-09&sub=(month|agenda)&layers=project%2Cchecklist&focus=${ID}$`));
    expect(links[1]!.getAttribute("href")).toBe(`/?view=timeline&focus=${ID}`);
  });

  it("keeps a 44px touch target at phone width, enabled or disabled", async () => {
    await mount(project({ deadlineSchedule: withDeadline }));
    for (const id of ["Show in Calendar", "Show in Timeline"]) {
      expect(host.querySelector(`[aria-label="${id}"]`)!.className).toContain("max-[721px]:min-h-[44px]");
    }
    await mount(project({ shootDate: null }));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Show in Calendar"]')!.disabled).toBe(true);
    expect(host.querySelector('[aria-label="Show in Calendar"]')!.className).toContain("max-[721px]:min-h-[44px]");
  });

  it("a plain click pushes through the location store; a modified click is left to the browser", async () => {
    const push = vi.spyOn(locationStore(), "push").mockImplementation(() => undefined);
    await mount(project({ deadlineSchedule: withDeadline }));
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    await act(async () => { timeline()!.dispatchEvent(plain); });
    expect(push).toHaveBeenCalledWith(`/?view=timeline&focus=${ID}`);
    expect(plain.defaultPrevented).toBe(true);
    push.mockClear();
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, metaKey: true });
    await act(async () => { timeline()!.dispatchEvent(modified); });
    expect(push).not.toHaveBeenCalled();
    expect(modified.defaultPrevented).toBe(false);
  });

  it("with nothing scheduled the Calendar button is disabled and says why; the Timeline stays a link", async () => {
    await mount(project());
    expect(calendar()).toBeInstanceOf(HTMLButtonElement);
    expect((calendar() as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[data-testid="project-show-in-reason"]')!.textContent).toBe("Nothing scheduled");
    expect(calendar()!.getAttribute("aria-describedby")).toBe(host.querySelector('[data-testid="project-show-in-reason"]')!.id);
    expect(timeline()!.tagName).toBe("A");
  });

  it("reads the earliest scheduled task from the subtasks cache once it arrives", async () => {
    await mount(project());
    expect((calendar() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      client.setQueryData(projectDataKeys.subtasks(ID), [{ id: "1a3b9c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f", title: "Edit", done: false, position: 0, schedule: { start: { localCivil: "2026-10-03T09:00" } } }]);
    });
    expect(calendar()!.tagName).toBe("A");
    expect(calendar()!.getAttribute("href")).toContain("date=2026-10-03");
  });

  it("an archived Project is disabled for a non-Admin, with the reason, and available to an Admin", async () => {
    await mount(project({ archivedAt: "2026-09-01T00:00:00Z", deadlineSchedule: withDeadline }));
    expect((calendar() as HTMLButtonElement).disabled).toBe(true);
    expect((timeline() as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[data-testid="project-show-in-reason"]')!.textContent).toBe("Archived Projects are shown to Admins only");
    roleState.role = "admin";
    await mount(project({ archivedAt: "2026-09-01T00:00:00Z", deadlineSchedule: withDeadline }));
    expect(timeline()!.getAttribute("href")).toBe(`/?view=timeline&archived=include&focus=${ID}`);
  });
});
