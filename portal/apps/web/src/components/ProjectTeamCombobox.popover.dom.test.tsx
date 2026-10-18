import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { ProjectTeamCombobox } from "./ProjectTeamCombobox";
import { projectDataKeys, type ProjectMember } from "../lib/project-data";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import "../styles/index.css";

/**
 * #914 D3 — the Project header's Team: `presentation="popover"`. An avatar-stack trigger opens the grouped picker with the search
 * inside the popup. The cases mirror `ProjectTeamCombobox.dom.test.tsx` 1–9, 11 and 12 (the chips presentation), against the same
 * mutations: a pick adds under its group's role; pressing a checked person removes them, with the same probe and confirmation.
 */

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { role: "editor" } } }) }));

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPutMock = vi.fn<(path: string) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const confirmMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPutWithStatus: (path: string) => apiPutMock(path), apiDeleteWithBody: (path: string, body: unknown) => apiDeleteMock(path, body) };
});
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

const projectId = "11111111-1111-4111-8111-111111111111";
const photographer = { id: "22222222-2222-4222-8222-222222222222", name: "Ari Photographer", email: "ari@example.test", globalRole: "photographer" as const, active: true as const };
const editor = { id: "33333333-3333-4333-8333-333333333333", name: "Eli Editor", email: "eli@example.test", globalRole: "editor" as const, active: true as const };
const eliMember: ProjectMember = { id: "44444444-4444-4444-8444-444444444444", userId: editor.id, roleOnProject: "editor", name: editor.name, email: editor.email, globalRole: "editor", active: true, assignedSubtaskCount: 2 };
const inactive: ProjectMember = { id: "45454545-4545-4545-8545-454545454545", userId: "55555555-5555-4555-8555-555555555555", roleOnProject: "editor", name: "Inactive Editor", email: "inactive@example.test", globalRole: "editor", active: false, assignedSubtaskCount: 0 };
const created = (userId: string, role: "photographer" | "editor", person: { name: string; email: string; globalRole: ProjectMember["globalRole"] }) =>
  ({ status: 201, data: { outcome: "created", membership: { id: "66666666-6666-4666-8666-666666666666", userId, roleOnProject: role, name: person.name, email: person.email, globalRole: person.globalRole, active: true, assignedSubtaskCount: 0 } } });

let root: Root | null = null;
let host: HTMLElement;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(rounds = 1) {
  await act(async () => { for (let index = 0; index < rounds; index += 1) { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); } });
}
async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

type MountProps = { canEdit?: boolean; archived?: boolean; onArchivedRefusal?: () => void; presentation?: "popover" | "inline" };
async function render(members: ProjectMember[], props: MountProps = {}) {
  await act(async () => {
    root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}>
      <ProjectTeamCombobox presentation={props.presentation ?? "popover"} projectId={projectId} members={members} canEdit={props.canEdit ?? true} archived={props.archived} onArchivedRefusal={props.onArchivedRefusal} />
    </QueryClientProvider></ProjectQueryRuntimeProvider>);
    await Promise.resolve();
  });
  await flush();
}
async function mount(members: ProjectMember[] = [], props: MountProps = {}) {
  host = document.createElement("div"); document.body.appendChild(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  root = createRoot(host);
  await render(members, props);
  return host;
}

const trigger = () => host.querySelector<HTMLButtonElement>('[data-testid="project-team-trigger"]')!;
const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search people"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const option = (text: string) => options().find((el) => el.textContent?.includes(text))!;
const isDisabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled");

async function openPicker() {
  await act(async () => { trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger().click(); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
  await flush();
}
async function typeQuery(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(search(), text); search().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); await Promise.resolve(); });
}
async function press(el: HTMLElement) {
  await act(async () => { el.click(); await Promise.resolve(); });
}
async function key(el: Element, name: string) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); await Promise.resolve(); });
}

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue({ photographers: [photographer], editors: [editor] });
  apiPutMock.mockReset().mockResolvedValue(created(photographer.id, "photographer", photographer));
  apiDeleteMock.mockReset().mockResolvedValue({ outcome: "removed", removed: { membershipCycle: eliMember.id, userId: eliMember.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
  confirmMock.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; runtime?.dispose(); queryClient?.clear(); document.body.replaceChildren(); vi.restoreAllMocks();
});

describe("ProjectTeamCombobox popover presentation (#914 D3)", () => {
  it("names the trigger from its people, shows three faces then +N, and reads 'Team: nobody assigned' with Add team when empty", async () => {
    const people = ["Ana", "Bo", "Cy", "Di"].map((name, index) => ({ ...eliMember, id: `0000000${index}-0000-4000-8000-000000000000`, userId: `1000000${index}-0000-4000-8000-000000000000`, name, email: `${name.toLowerCase()}@x.test` }));
    await mount(people);
    expect(trigger().getAttribute("aria-label")).toBe("Team: Ana, Bo, Cy, Di");
    expect(trigger().textContent).toContain("+1");
    // Three faces then the +1 chip (AvatarStack `fullLimit`), decorative inside the named trigger.
    expect([...trigger().querySelectorAll('[role="img"]')].map((el) => el.getAttribute("aria-label"))).toEqual(["Ana", "Bo", "Cy", "1 more team member"]);
    expect(trigger().querySelector('[role="img"]')!.closest('[aria-hidden="true"]')).not.toBeNull();
    // The chips presentation's input and × are not here.
    expect(host.querySelector('[aria-label="Add team member"]')).toBeNull();
    expect(host.querySelector('[data-testid="project-member-remove"]')).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount([]);
    expect(trigger().getAttribute("aria-label")).toBe("Team: nobody assigned");
    expect(trigger().textContent).toContain("Add team");
  });

  it("1. selects a candidate (PUT), keeps the popup open with the query retained, and publishes activity/dashboard/calendar", async () => {
    await mount([]);
    const publish = vi.spyOn(runtime, "publish");
    await openPicker();
    await typeQuery("ari");
    await waitFor(() => expect(option("Ari Photographer")).toBeDefined());
    await press(option("Ari Photographer"));
    await flush(2);
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/photographers/${photographer.id}`);
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(search().value).toBe("ari");
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "activity" }]))).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
  });

  it("2. shows D3's header, a 'Team candidates' listbox with its groups and footer, and moves the highlight with ArrowDown", async () => {
    apiGetMock.mockResolvedValue({ photographers: [photographer, { ...photographer, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Bea Photographer" }], editors: [editor] });
    await mount([eliMember]);
    await openPicker();
    const popup = document.querySelector<HTMLElement>('[data-testid="project-team-options"]')!;
    expect(popup.querySelector('[data-testid="project-team-assigned"]')?.textContent).toBe("1 assigned");
    expect(search()).not.toBeNull();
    const listbox = document.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute("aria-label")).toBe("Team candidates");
    expect(listbox.textContent).toContain("Photographers");
    expect(listbox.textContent).toContain("Editors");
    expect(popup.textContent).toContain("The group you pick from sets the person’s role.");
    // The assigned person is checked under their role.
    expect(option("Eli Editor").getAttribute("aria-selected")).toBe("true");
    // The keyboard starts on the checked person (Eli, last in group order); one ArrowUp lands on Bea, a specific target.
    // (happy-dom: the first key after opening can land before the list registers its rows, so step until one is highlighted.)
    for (let step = 0; step < 3 && !document.querySelector('[role="option"][data-highlighted]'); step += 1) await key(search(), "ArrowDown");
    expect(document.querySelector('[role="option"][data-highlighted]')?.textContent).toContain("Eli Editor");
    await key(search(), "ArrowUp");
    await waitFor(() => expect(document.querySelector('[role="option"][data-highlighted]')?.textContent).toContain("Bea Photographer"));
  });

  it("search: typing 'ari' excludes Eli Editor's option", async () => {
    await mount([]);
    await openPicker();
    await typeQuery("ari");
    await waitFor(() => expect(options().some((el) => el.textContent?.includes("Ari Photographer"))).toBe(true));
    expect(options().some((el) => el.textContent?.includes("Eli Editor"))).toBe(false);
  });

  it("3. disables only the pending option while another candidate stays actionable", async () => {
    let resolvePut!: (value: unknown) => void;
    apiPutMock.mockReturnValueOnce(new Promise((resolve) => { resolvePut = resolve; }));
    await mount([]);
    await openPicker();
    await press(option("Ari Photographer"));
    await flush();
    expect(isDisabled(option("Ari Photographer"))).toBe(true);
    expect(option("Ari Photographer").getAttribute("aria-busy")).toBe("true");
    expect(isDisabled(option("Eli Editor"))).toBe(false);
    resolvePut(created(photographer.id, "photographer", photographer));
    await flush();
  });

  it("4. pressing a checked person probes final-role removal, then confirms with the server count", async () => {
    apiDeleteMock.mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 })).mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: eliMember.id, userId: eliMember.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
    const unknown = { ...eliMember } as Partial<ProjectMember>;
    delete unknown.assignedSubtaskCount;
    await mount([unknown as ProjectMember]);
    const publish = vi.spyOn(runtime, "publish");
    await openPicker();
    await press(option("Eli Editor"));
    await flush(4);
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: "Remove and unassign", message: expect.stringContaining("2 checklist items") }));
    expect(apiDeleteMock.mock.calls.map(([, body]) => body)).toEqual([
      { membershipCycle: eliMember.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 },
      { membershipCycle: eliMember.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 2 },
    ]);
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated" && JSON.stringify(message.resources) === JSON.stringify([{ kind: "activity" }, { kind: "subtasks" }]))).toBe(true);
  });

  it("5. shows a generic error inside the popup and stops when the confirmation response omits its count", async () => {
    apiDeleteMock.mockRejectedValueOnce(new ApiError("malformed", 422, { code: "subtask_assignment_confirmation_required" }));
    await mount([eliMember]);
    await openPicker();
    await press(option("Eli Editor"));
    await flush(4);
    const message = document.querySelector(`[data-testid="project-member-message-editor:${eliMember.userId}"]`);
    expect(message?.textContent).toContain("Assignment could not be removed.");
    expect(document.querySelector('[data-testid="project-team-options"]')?.contains(message!)).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
  });

  it("6. requires fresh confirmation when the assignment count changes between retries", async () => {
    apiDeleteMock
      .mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }))
      .mockRejectedValueOnce(new ApiError("changed", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 3 }))
      .mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: eliMember.id, userId: eliMember.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 3 });
    await mount([eliMember]);
    await openPicker();
    await press(option("Eli Editor"));
    await flush(6);
    expect(confirmMock.mock.calls.map(([opts]) => (opts as { message: string }).message)).toEqual([expect.stringContaining("2 checklist items"), expect.stringContaining("3 checklist items")]);
    expect(apiDeleteMock).toHaveBeenCalledTimes(3);
  });

  it("7. always probes before confirming, even with a cached known count", async () => {
    apiDeleteMock
      .mockRejectedValueOnce(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }))
      .mockResolvedValueOnce({ outcome: "removed", removed: { membershipCycle: eliMember.id, userId: eliMember.userId, roleOnProject: "editor" }, subtaskAssignmentsCleared: 2 });
    await mount([eliMember]);
    await openPicker();
    await press(option("Eli Editor"));
    await flush(3);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(apiDeleteMock.mock.calls[0]?.[1]).toEqual({ membershipCycle: eliMember.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
  });

  it("8. merges a DELETE 409 membership into only its cell, refetches, leaves the picker open, and marks the row conflicted", async () => {
    const current = { ...eliMember, id: "99999999-9999-4999-8999-999999999999" };
    const other: ProjectMember = { ...eliMember, id: "88888888-8888-4888-8888-888888888888", userId: photographer.id, name: photographer.name, email: photographer.email, globalRole: "photographer", roleOnProject: "photographer", assignedSubtaskCount: 0 };
    apiDeleteMock.mockRejectedValueOnce(new ApiError("stale", 409, { code: "membership_cycle_changed", currentMembership: current }));
    await mount([eliMember, other]);
    queryClient.setQueryData(projectDataKeys.detail(projectId), { id: projectId, members: [eliMember, other] });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await openPicker();
    await press(option("Eli Editor"));
    await flush(4);
    const detail = queryClient.getQueryData<{ members: ProjectMember[] }>(projectDataKeys.detail(projectId));
    expect(detail?.members).toHaveLength(2);
    expect(detail?.members).toEqual(expect.arrayContaining([expect.objectContaining({ id: current.id }), expect.objectContaining({ id: other.id })]));
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail(projectId), exact: true }));
    expect(document.querySelector(`[data-testid="project-team-option-editor:${editor.id}"]`)?.getAttribute("data-state")).toBe("conflict");
  });

  it("9. rolls back only the failed cell, keeps the failure in the popup, and describes the row by it", async () => {
    apiDeleteMock.mockRejectedValueOnce(new Error("No network"));
    await mount([eliMember]);
    await openPicker();
    await press(option("Eli Editor"));
    await flush(4);
    const message = document.querySelector<HTMLElement>(`[data-testid="project-member-message-editor:${editor.id}"]`)!;
    expect(message.textContent).toContain("No network");
    const row = document.querySelector<HTMLElement>(`[data-testid="project-team-option-editor:${editor.id}"]`)!;
    expect(row.getAttribute("data-state")).toBe("error");
    expect(row.getAttribute("aria-describedby")).toBe(message.id);
    expect(trigger().getAttribute("aria-label")).toBe("Team: Eli Editor");
  });

  it("lists an inactive member, checked under their role, so pressing it is their remove; never as an addable candidate", async () => {
    await mount([inactive]);
    await openPicker();
    const rows = options().filter((el) => el.textContent?.includes("Inactive Editor"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[0]!.textContent).toContain("Inactive");
    await press(rows[0]!);
    await flush(3);
    expect(apiDeleteMock).toHaveBeenCalledOnce();
  });

  it("11. Escape closes the popup and returns focus to the trigger", async () => {
    await mount([]);
    await act(async () => { trigger().focus(); });
    await openPicker();
    await key(document.activeElement ?? search(), "Escape");
    await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("12. disables and marks the search invalid when the candidates query errors, keeping the alert", async () => {
    apiGetMock.mockReset().mockRejectedValue(new ApiError("Candidates unavailable", 400));
    await mount([]);
    await flush(4);
    await openPicker();
    expect(search().disabled).toBe(true);
    expect(search().getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[data-testid="project-team-options"] [role="alert"]')?.textContent).toContain("Candidates could not be loaded");
  });

  it("D6: a read-only role gets a flat value with no trigger, no chevron and no candidates request", async () => {
    await mount([eliMember], { canEdit: false });
    expect(host.querySelector('[data-testid="project-team-trigger"]')).toBeNull();
    const value = host.querySelector<HTMLElement>('[data-header-value="team"]')!;
    expect(value.querySelector("svg")).toBeNull();
    expect(value.getAttribute("role")).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("an archived refusal flips it read-only, focuses the Team group, and tells the host so its latch can follow (#455)", async () => {
    const onArchivedRefusal = vi.fn();
    apiPutMock.mockRejectedValueOnce(new ApiError("archived", 409, { code: "membership_project_archived" }));
    await mount([], { onArchivedRefusal });
    await openPicker();
    await press(option("Ari Photographer"));
    await flush(4);
    expect(onArchivedRefusal).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="project-team-trigger"]')).toBeNull();
    const group = host.querySelector<HTMLElement>('[data-header-value="team"]')!;
    expect(group.getAttribute("role")).toBe("group");
    await waitFor(() => expect(document.activeElement).toBe(group));
  });
});

// #914 D3 (browser pass): Base UI scrolls the first selected option into view as the list opens (`useListNavigation`'s
// `forceScrollIntoView`); measured at 129px in the 320px popup, it hid the Photographers heading under the search. The list opens at
// its top instead. The stub stands in for the browser's scroll: happy-dom has no `scrollIntoView`.
function stubOpenScroll() {
  const calls: Element[] = [];
  const original = (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    calls.push(this);
    for (let element: HTMLElement | null = this.parentElement; element; element = element.parentElement) element.scrollTop = 129;
  };
  return { calls, restore: () => { if (original) HTMLElement.prototype.scrollIntoView = original as never; else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView; } };
}
async function frames(count: number) {
  for (let index = 0; index < count; index += 1) await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
}

describe("the Team list opens at its top (#914 D3, M6)", () => {
  it("popover: the selected person is not scrolled into view on open; the first group heading shows", async () => {
    const stub = stubOpenScroll();
    try {
      await mount([eliMember]);
      await openPicker();
      await frames(4);
      expect(stub.calls.length, "the open-time scroll this guards against").toBeGreaterThan(0);
      const list = document.querySelector<HTMLElement>('[data-slot="combobox-list"]')!;
      expect(list.scrollTop).toBe(0);
    } finally { stub.restore(); }
  });

  it("inline: the list and its scroller open at the top", async () => {
    const stub = stubOpenScroll();
    try {
      await mount([eliMember], { presentation: "inline" });
      await waitFor(() => expect(options().length).toBeGreaterThan(0));
      await frames(4);
      expect(stub.calls.length).toBeGreaterThan(0);
      const list = document.querySelector<HTMLElement>('[data-slot="combobox-list"]')!;
      for (let element: HTMLElement | null = list; element && element !== host; element = element.parentElement) expect(element.scrollTop, element.className).toBe(0);
    } finally { stub.restore(); }
  });

  it("leaves a scroll the person makes alone", async () => {
    await mount([eliMember]);
    await openPicker();
    await frames(1);
    const list = document.querySelector<HTMLElement>('[data-slot="combobox-list"]')!;
    await act(async () => { list.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); list.scrollTop = 40; });
    await frames(4);
    expect(list.scrollTop).toBe(40);
  });
});

// #914 D2 "Manage" / M6: the same grouped picker drawn in place.
describe("ProjectTeamCombobox inline presentation (#914 D2, M6)", () => {
  it("renders the search and grouped list with no popup or trigger, and a pick still sets the role from its group", async () => {
    await mount([eliMember], { presentation: "inline" });
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(host.querySelector('[data-testid="project-team-trigger"]')).toBeNull();
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(list.getAttribute("aria-label")).toBe("Team candidates");
    // In place: inside the control's own subtree, not portalled into a popup.
    expect(host.contains(list)).toBe(true);
    expect(host.contains(search())).toBe(true);
    expect(host.textContent).toContain("Photographers");
    expect(host.textContent).toContain("Editors");
    expect(option("Eli Editor").getAttribute("aria-selected")).toBe("true");
    await press(option("Ari Photographer"));
    await flush(2);
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/photographers/${photographer.id}`);
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("M6 `fill`: the helper line scrolls with the results instead of staying pinned under them", async () => {
    await act(async () => {
      host = document.createElement("div"); document.body.appendChild(host);
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      runtime = new ProjectQueryRuntime(queryClient);
      root = createRoot(host);
      root.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}>
        <ProjectTeamCombobox presentation="inline" fill projectId={projectId} members={[eliMember]} canEdit />
      </QueryClientProvider></ProjectQueryRuntimeProvider>);
      await Promise.resolve();
    });
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    const helper = [...host.querySelectorAll("p")].find((element) => element.textContent?.startsWith("The group you pick from"))!;
    const scroller = document.querySelector<HTMLElement>('[data-slot="combobox-list"]')!.parentElement!;
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.contains(helper)).toBe(true);
  });

  it("is a named read-only group with the names when archived, and asks for no candidates", async () => {
    await mount([eliMember], { presentation: "inline", archived: true });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    const group = host.querySelector<HTMLElement>('[role="group"][aria-label="Team"]')!;
    expect(group.textContent).toBe("Eli Editor");
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});
