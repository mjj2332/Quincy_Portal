import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiGet: (path: string) => apiGetMock(path),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
  };
});

import { CreateProject } from "./CreateProject";
import "@/testing/dom-polyfills";
import { applyPopup, dateTimePopup, openFieldPopup, pickPopupDay, pressInPopup, typePopupTime } from "@/testing/date-time-popup";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
}

// The Team combobox reads candidates through react-query, which needs a client (the app root provides one).
async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={client}><CreateProject onNavigate={() => undefined} /></QueryClientProvider>); await Promise.resolve(); await Promise.resolve(); });
  await flush();
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

async function typeInto(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function submit() {
  const button = host.querySelector<HTMLButtonElement>('[data-testid="create-project-submit"]')!;
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  await flush();
}

const photographer = { id: "22222222-2222-4222-8222-222222222222", name: "Ari Photographer", email: "ari@example.test", globalRole: "photographer", active: true };
const editor = { id: "33333333-3333-4333-8333-333333333333", name: "Eli Editor", email: "eli@example.test", globalRole: "editor", active: true, defaultEditor: false };
const defaultEditor = { id: "77777777-7777-4777-8777-777777777777", name: "Dee Default", email: "dee@example.test", globalRole: "editor", active: true, defaultEditor: true };
const dualRole = { id: "88888888-8888-4888-8888-888888888888", name: "Dana Dual", email: "dana@example.test", globalRole: "editor", active: true, defaultEditor: false };

async function pickTeamMember(query: string, name: string, group: "Photographers" | "Editors") {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Add team member"]')!;
  await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
  await typeInto(input, query);
  const find = () => [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((element) => element.textContent?.startsWith(group))
    ?.querySelectorAll<HTMLElement>('[role="option"]');
  for (let attempt = 0; attempt < 50 && ![...(find() ?? [])].some((option) => option.textContent?.includes(name)); attempt += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
  const option = [...(find() ?? [])].find((candidate) => candidate.textContent?.includes(name))!;
  await act(async () => { option.click(); await Promise.resolve(); });
  await flush();
}

function clientInput(id: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing Client input ${id}`);
  return input;
}

beforeEach(() => {
  mount();
  apiGetMock.mockReset().mockImplementation(async (path) => {
    if (path === "/api/project-assignment-candidates") return { photographers: [photographer, dualRole], editors: [editor, defaultEditor, dualRole] };
    throw new Error(`Unexpected apiGet path: ${path}`);
  });
  apiPostMock.mockReset().mockResolvedValue({ id: "project-created", collections: [], members: [] });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
});

describe("CreateProject Client payload", () => {
  it("submits the real Create path with trimmed and whitespace-only optional Client values", async () => {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Test Street");
    await typeInto(clientInput("project-agency-name"), " Agency ");
    await typeInto(clientInput("project-agent-name"), " Agent ");
    await typeInto(clientInput("project-agent-email"), " agent@example.test ");
    await typeInto(clientInput("project-agent-phone"), " +61 412 345 678 ");
    await submit();

    expect(apiGetMock).toHaveBeenCalledWith("/api/project-assignment-candidates");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
      street: "12 Test Street",
      agencyName: "Agency",
      agentName: "Agent",
      agentEmail: "agent@example.test",
      agentPhone: "+61 412 345 678",
    }));

    apiPostMock.mockClear();
    await typeInto(clientInput("project-agency-name"), "  ");
    await typeInto(clientInput("project-agent-name"), "\t");
    await typeInto(clientInput("project-agent-email"), " \n ");
    await typeInto(clientInput("project-agent-phone"), "  ");
    await submit();

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
      street: "12 Test Street",
      agencyName: null,
      agentName: null,
      agentEmail: null,
      agentPhone: null,
    }));
  });

  it("broadcasts Board and Calendar after creating the initial roster", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient);
    const publish = vi.spyOn(runtime, "publish");
    const onNavigate = vi.fn();
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><CreateProject onNavigate={onNavigate} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Broadcast Street");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="create-project-hero-submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(publish.mock.calls.some(([message]) => message.type === "dashboard-board-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "production-calendar-invalidated")).toBe(true);
    expect(publish.mock.calls.some(([message]) => message.type === "project-data-invalidated")).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith("/projects/project-created", "Shoot created.");
    runtime.dispose(); queryClient.clear();
  });

  it("takes the shoot date from the date popup, not a native date input (#421)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T02:00:00Z") }); // Thu 1 Oct, Sydney
    try {
      await render();
      expect(host.querySelector('input[type="date"]')).toBeNull();
      await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Test Street");
      const popupButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="Shoot date"] button')].find((button) => button.textContent?.startsWith(name))!;
      await act(async () => { host.querySelector<HTMLButtonElement>("button#project-shoot-date")!.click(); await Promise.resolve(); await Promise.resolve(); });
      await flush();
      for (const name of ["Tomorrow", "Apply"]) { await act(async () => { popupButton(name).click(); await Promise.resolve(); }); await flush(); }
      await submit();
      expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ shootDate: "2026-10-02" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CreateProject Team (#487)", () => {
  it("sends the picked photographer and editor in the create request", async () => {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Team Street");
    await pickTeamMember("ari", "Ari Photographer", "Photographers");
    await pickTeamMember("eli", "Eli Editor", "Editors");
    await submit();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ photographerUserIds: [photographer.id], editorUserIds: [editor.id] }));
  });

  it("shows the Default editor as a chip but never submits it in editorUserIds", async () => {
    await render();
    for (let attempt = 0; attempt < 50 && !host.querySelector(`[data-testid="project-member-editor:${defaultEditor.id}"]`); attempt += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
    const chip = host.querySelector(`[data-testid="project-member-editor:${defaultEditor.id}"]`)!;
    expect(chip.textContent).toContain("Default editor");
    expect(chip.querySelector('[data-testid="project-member-remove"]')).toBeNull();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Default Street");
    await submit();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ photographerUserIds: [], editorUserIds: [] }));
  });

  it("keeps the picked team when validation blocks the submit, then sends it once fixed", async () => {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Keep Street");
    await typeInto(clientInput("project-agent-email"), "not-an-email");
    await pickTeamMember("ari", "Ari Photographer", "Photographers");
    await submit();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(host.querySelector(`[data-testid="project-member-photographer:${photographer.id}"]`)).not.toBeNull();
    await typeInto(clientInput("project-agent-email"), "agent@example.test");
    await submit();
    expect(apiPostMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ photographerUserIds: [photographer.id] }));
  });

  it("does not submit the form when Enter is pressed in the team search input", async () => {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, "12 Enter Street");
    const input = host.querySelector<HTMLInputElement>('[aria-label="Add team member"]')!;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { input.focus(); input.dispatchEvent(enter); await Promise.resolve(); });
    await flush();
    // A synthetic key event never triggers implicit submission itself, so the default being cancelled is what stops a real one.
    expect(enter.defaultPrevented).toBe(true);
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});

describe("CreateProject Deadline and Priority (#488)", () => {
  // Thu 1 Oct 2026 in Sydney. The Sydney clocks go forward on Sun 4 Oct, so a Fri 2 Oct shoot is due Mon 5 Oct 17:00.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T02:00:00Z") }); });
  afterEach(() => { vi.useRealTimers(); });

  const deadlineField = () => host.querySelector<HTMLButtonElement>("button#project-deadline")!;
  const deadlineText = () => deadlineField().textContent ?? "";
  const body = () => apiPostMock.mock.calls.at(-1)![1] as Record<string, unknown>;

  async function startShoot(street = "12 Deadline Street") {
    await render();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="12 Kings Road, Vaucluse"]')!, street);
  }

  async function pickShootDate(day: string) {
    await act(async () => { host.querySelector<HTMLButtonElement>("button#project-shoot-date")!.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush();
    const popup = dateTimePopup("Shoot date")!;
    await pickPopupDay(popup, day);
    await applyPopup(popup);
    await flush();
  }

  async function setDeadline(draft: { day?: string; time?: string; shortcut?: string }) {
    const popup = await openFieldPopup("Deadline", host);
    if (draft.shortcut) await pressInPopup(popup, draft.shortcut);
    if (draft.day) await pickPopupDay(popup, draft.day);
    if (draft.time) await typePopupTime(popup, draft.time);
    await applyPopup(popup);
    await flush();
  }

  async function pressStar(label: string) {
    const star = host.querySelector<HTMLElement>(`[role="radio"][aria-label="${label}"]`)!;
    await act(async () => { star.click(); await Promise.resolve(); });
  }

  it("starts empty with a hint, and sends no Deadline and no Priority", async () => {
    await startShoot();
    expect(deadlineText()).toContain("Select a date and time");
    expect(host.textContent).toContain("Set automatically from the shoot date once one is picked.");
    expect(host.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(0);
    await submit();
    expect(body()).toMatchObject({ deadline: null, priority: null });
  });

  it("shows the Automatic Deadline once a shoot date is picked, follows a change of date, and sends null", async () => {
    await startShoot();
    await pickShootDate("2026-10-02");
    expect(deadlineText()).toContain("Mon 5 Oct 2026");
    expect(deadlineText()).toContain("17:00");
    expect(deadlineField().getAttribute("aria-labelledby")!.split(" ").map((id) => document.getElementById(id)?.textContent).join(" ")).toContain("Automatic");
    // #509: the adornment is the quiet mark, not a status pill.
    expect(host.querySelector('[data-testid="automatic-deadline-mark"]')?.textContent).toBe("Automatic");
    expect([...host.querySelectorAll('[data-slot="status-pill"]')].some((pill) => pill.textContent === "Automatic")).toBe(false);
    await pickShootDate("2026-10-05");
    expect(deadlineText()).toContain("Tue 6 Oct 2026");
    expect(deadlineText()).toContain("Automatic");
    await submit();
    expect(body()).toMatchObject({ shootDate: "2026-10-05", deadline: null });
  });

  it("explains the automatic preview in the popup, and drops the explanation once the Deadline is manual (#509)", async () => {
    await startShoot();
    await pickShootDate("2026-10-02");
    const note = "Automatic: the first weekday after the shoot, at 17:00. Change it to set your own.";
    const popup = await openFieldPopup("Deadline", host);
    expect(popup.textContent).toContain(note);
    await typePopupTime(popup, "10:00");
    await applyPopup(popup);
    await flush();
    const again = await openFieldPopup("Deadline", host);
    expect(again.textContent).not.toContain(note);
  });

  it("keeps an untouched Apply on the automatic preview automatic", async () => {
    await startShoot();
    await pickShootDate("2026-10-02");
    const popup = await openFieldPopup("Deadline", host);
    await applyPopup(popup);
    await flush();
    expect(deadlineText()).toContain("Automatic");
    await submit();
    expect(body()).toMatchObject({ deadline: null });
  });

  it("makes an edited Deadline manual, seeds the default reminders, and stops following the shoot date", async () => {
    await startShoot();
    await pickShootDate("2026-10-02");
    await setDeadline({ time: "10:00" });
    expect(deadlineText()).toContain("Mon 5 Oct 2026");
    expect(deadlineText()).toContain("10:00");
    expect(deadlineText()).not.toContain("Automatic");
    await pickShootDate("2026-10-09");
    expect(deadlineText()).toContain("Mon 5 Oct 2026");
    await submit();
    expect(body()).toMatchObject({ deadline: { localCivil: "2026-10-05T10:00", reminderOffsetsMinutes: [1440, 240, 60] } });
  });

  it("makes a manual Deadline set with no shoot date start with no advance reminders", async () => {
    await startShoot();
    await setDeadline({ day: "2026-10-08", time: "09:30" });
    await submit();
    expect(body()).toMatchObject({ shootDate: null, deadline: { localCivil: "2026-10-08T09:30", reminderOffsetsMinutes: [] } });
  });

  it("makes a reminder-only change on the automatic preview manual", async () => {
    await startShoot();
    await pickShootDate("2026-10-02");
    const popup = await openFieldPopup("Deadline", host);
    const chip = [...popup.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Advance reminders"] button[aria-pressed="true"]')].find((button) => !button.disabled);
    expect(chip).toBeDefined(); // the first pressed advance chip is the 1 day preset (1440 minutes)
    await act(async () => { chip!.click(); await Promise.resolve(); });
    await applyPopup(popup);
    await flush();
    expect(deadlineText()).not.toContain("Automatic");
    await submit();
    expect(body()).toMatchObject({ deadline: { localCivil: "2026-10-05T17:00", reminderOffsetsMinutes: [240, 60] } });
  });

  it("returns a cleared Deadline to automatic with a visible note, and sends null", async () => {
    await startShoot();
    await pickShootDate("2026-10-02");
    await setDeadline({ time: "10:00" });
    expect(host.textContent).not.toContain("Cleared");
    await setDeadline({ shortcut: "No date" });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Cleared — back to the Automatic Deadline.");
    expect(deadlineText()).toContain("Mon 5 Oct 2026");
    expect(deadlineText()).toContain("Automatic");
    await submit();
    expect(body()).toMatchObject({ deadline: null });
  });

  it("starts Priority unset, sends the picked stars, and clears them again", async () => {
    await startShoot();
    await pressStar("4 stars");
    expect(host.querySelector('[role="radio"][aria-label="4 stars"]')!.getAttribute("aria-checked")).toBe("true");
    await submit();
    expect(body()).toMatchObject({ priority: 4 });
    await pressStar("4 stars");
    await submit();
    expect(body()).toMatchObject({ priority: null });
  });

  it("names the Priority group after the street being entered", async () => {
    await startShoot("12 Named Street");
    expect(host.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Priority for 12 Named Street");
  });

  it("keeps the Deadline and Priority when validation blocks the submit, and again when the server refuses", async () => {
    await startShoot();
    await pickShootDate("2026-10-02");
    await setDeadline({ time: "10:00" });
    await pressStar("2 stars");
    await typeInto(clientInput("project-agent-email"), "not-an-email");
    await submit();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(deadlineText()).toContain("10:00");
    expect(host.querySelector('[role="radio"][aria-label="2 stars"]')!.getAttribute("aria-checked")).toBe("true");
    await typeInto(clientInput("project-agent-email"), "agent@example.test");
    apiPostMock.mockRejectedValueOnce(new Error("The server said no."));
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The server said no.");
    expect(deadlineText()).toContain("10:00");
    expect(host.querySelector('[role="radio"][aria-label="2 stars"]')!.getAttribute("aria-checked")).toBe("true");
    await submit();
    expect(body()).toMatchObject({ deadline: { localCivil: "2026-10-05T10:00" }, priority: 2 });
  });

  it("sends the same Deadline and Priority from the top Create button as from the details button", async () => {
    await startShoot();
    await pickShootDate("2026-10-02");
    await setDeadline({ time: "10:00" });
    await pressStar("5 stars");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="create-project-hero-submit"]')!.click(); await Promise.resolve(); });
    await flush();
    const hero = body();
    await submit();
    expect(body()).toEqual(hero);
  });
});
