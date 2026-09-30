import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { SubtaskAssigneePicker } from "./SubtaskAssigneePicker";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = "11111111-1111-4111-8111-111111111111";
const ids = { nora: "22222222-2222-4222-8222-222222222222", ada: "33333333-3333-4333-8333-333333333333", ben: "44444444-4444-4444-8444-444444444444", cy: "55555555-5555-4555-8555-555555555555" };
const candidates = [
  { id: ids.ada, name: "Ada Smith", role: "photographer" },
  { id: ids.ben, name: "Ben Ortiz", role: "editor" },
  { id: ids.cy, name: "Cy Young", role: "editor" },
  { id: ids.nora, name: "Nora Jones", role: "editor" },
];
const person = (key: keyof typeof ids, name: string) => ({ id: ids[key], name });

let root: Root | null = null;
let host: HTMLDivElement;
let queryClient: QueryClient;
const onCommit = vi.fn<(ids: string[], people: Array<{ id: string; name: string }>, baseline: { ids: string[]; version: number | undefined }) => void | Promise<void>>();

type Props = Partial<Parameters<typeof SubtaskAssigneePicker>[0]>;
async function mount(props: Props = {}) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}><SubtaskAssigneePicker projectId={projectId} role="admin" label="Assignees for Call client" selected={[]} onCommit={onCommit} {...props} /></QueryClientProvider>);
    await Promise.resolve();
  });
  return host;
}
async function rerender(props: Props) {
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}><SubtaskAssigneePicker projectId={projectId} role="admin" label="Assignees for Call client" selected={[]} onCommit={onCommit} {...props} /></QueryClientProvider>);
    await Promise.resolve();
  });
}
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Assignees for Call client"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const nameOf = (option: HTMLElement) => option.querySelector('[data-testid="assignee-option-name"]')!.textContent!.replace(/Inactive/, "").trim();
const optionNames = () => options().map(nameOf);
const search = () => document.querySelector<HTMLInputElement>('input[placeholder="Search people…"]')!;

async function waitFor(assertion: () => void, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}
async function open() {
  await act(async () => { trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger().click(); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function pick(name: string) {
  const option = options().find((candidate) => candidate.textContent?.includes(name));
  if (!option) throw new Error(`No option ${name}`);
  await act(async () => { option.click(); await Promise.resolve(); });
}
async function key(element: Element, name: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); await Promise.resolve(); });
}
async function typeQuery(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(search(), text); search().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); await Promise.resolve(); });
}
async function closeWithEscape() {
  await key(document.activeElement ?? search(), "Escape");
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
}

beforeEach(() => {
  onCommit.mockReset().mockResolvedValue(undefined);
  apiGetMock.mockReset().mockResolvedValue({ candidates });
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; queryClient?.clear(); document.body.replaceChildren();
});

describe("SubtaskAssigneePicker", () => {
  it("an untouched picker sends nothing even when a refetch changes the selection while it is open (#368 review)", async () => {
    await mount({ selected: [person("nora", "Nora Jones")], version: 1 });
    await open();
    await rerender({ selected: [person("nora", "Nora Jones"), person("ada", "Ada Smith")], version: 2 });
    await closeWithEscape();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits against the selection and version captured at open, not a refetch that landed since", async () => {
    await mount({ selected: [person("nora", "Nora Jones")], version: 1 });
    await open();
    await rerender({ selected: [person("nora", "Nora Jones"), person("ada", "Ada Smith")], version: 2 });
    await pick("Ben Ortiz");
    await closeWithEscape();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toEqual([ids.nora, ids.ben]);
    expect(onCommit.mock.calls[0]![2]).toEqual({ ids: [ids.nora], version: 1 });
  });

  it("fetches the options only after the first open, and only once", async () => {
    await mount({ selected: [person("nora", "Nora Jones")] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(apiGetMock).not.toHaveBeenCalled();
    await open();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${projectId}/subtask-assignee-options`));
    await closeWithEscape();
    await open();
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it("shows the selection as an avatar stack on the trigger, with the hidden count", async () => {
    await mount({ selected: [person("nora", "Nora Jones"), person("ada", "Ada Smith")], hiddenCount: 2 });
    expect([...trigger().querySelectorAll('[role="img"]')].map((el) => el.getAttribute("aria-label"))).toEqual(["Nora Jones", "Ada Smith", "2 others not shown"]);
  });

  it("titles the trigger with the assignees' names and 'and N others' for hidden people, so shared initials stay distinguishable", async () => {
    await mount({ selected: [person("nora", "TB4E Ed QA"), person("ada", "TB4E Ext QA")], hiddenCount: 2 });
    expect(trigger().getAttribute("title")).toBe("TB4E Ed QA, TB4E Ext QA and 2 others");
    await rerender({ selected: [person("nora", "Nora Jones")], hiddenCount: 0 });
    expect(trigger().getAttribute("title")).toBe("Nora Jones");
    await rerender({ selected: [], hiddenCount: 1 });
    expect(trigger().getAttribute("title")).toBe("1 other");
  });

  it("titles an unassigned trigger as Unassigned", async () => {
    await mount();
    expect(trigger().getAttribute("title")).toBe("Unassigned");
  });

  it("marks a deactivated selected person with the Inactive status pill", async () => {
    apiGetMock.mockResolvedValue({ candidates });
    await mount({ selected: [person("nora", "Nora Jones"), { id: "99999999-9999-4999-8999-999999999999", name: "Gone Person" }] });
    await open();
    await waitFor(() => expect(document.querySelectorAll('[data-slot="status-pill"]').length).toBe(1));
    expect(document.querySelector('[data-slot="status-pill"]')!.textContent).toBe("Inactive");
  });

  it("shows the empty glyph when nobody is assigned", async () => {
    await mount();
    // The shared add-person glyph (#372), not AvatarStack's hairline circle; decorative, so the trigger's own name and title carry the meaning.
    expect(trigger().querySelector('[data-testid="empty-assignee-glyph"]')).not.toBeNull();
    expect(trigger().querySelectorAll('[role="img"]')).toHaveLength(0);
    expect(trigger().getAttribute("title")).toBe("Unassigned");
  });

  it("lists the selected people first, checked, then everyone else, and adds a deactivated selected person", async () => {
    const gone = { id: "66666666-6666-4666-8666-666666666666", name: "Gone Person" };
    await mount({ selected: [person("nora", "Nora Jones"), gone] });
    await open();
    await waitFor(() => expect(options().length).toBe(5));
    expect(optionNames()).toEqual(["Nora Jones", "Gone Person", "Ada Smith", "Ben Ortiz", "Cy Young"]);
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "true", "false", "false", "false"]);
  });

  it("filters by the search field and reports an empty match", async () => {
    await mount();
    await open();
    await waitFor(() => expect(options().length).toBe(4));
    await typeQuery("ben");
    await waitFor(() => expect(optionNames()).toEqual(["Ben Ortiz"]));
    await typeQuery("zzz");
    await waitFor(() => expect(document.body.textContent).toContain("No matching people"));
  });

  it("commits once, on close, with every picked id, and stays open while picking", async () => {
    await mount();
    await open();
    await waitFor(() => expect(options().length).toBe(4));
    await pick("Ada Smith"); await pick("Ben Ortiz"); await pick("Cy Young");
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await closeWithEscape();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect([...onCommit.mock.calls[0]![0]].sort()).toEqual([ids.ada, ids.ben, ids.cy].sort());
    expect(onCommit.mock.calls[0]![1].map((entry) => entry.name).sort()).toEqual(["Ada Smith", "Ben Ortiz", "Cy Young"]);
  });

  it("commits the reduced set when a selected person is unpicked", async () => {
    await mount({ selected: [person("nora", "Nora Jones"), person("ada", "Ada Smith")] });
    await open();
    await waitFor(() => expect(options().length).toBe(4));
    await pick("Ada Smith");
    await closeWithEscape();
    expect(onCommit).toHaveBeenCalledTimes(1); expect(onCommit.mock.calls[0]![0]).toEqual([ids.nora]);
  });

  it("does not commit when the set is unchanged, even after toggling a person on and off", async () => {
    await mount({ selected: [person("nora", "Nora Jones")] });
    await open();
    await waitFor(() => expect(options().length).toBe(4));
    await pick("Ada Smith"); await pick("Ada Smith");
    await closeWithEscape();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits when the trigger is pressed again to close", async () => {
    await mount();
    await open();
    await waitFor(() => expect(options().length).toBe(4));
    await pick("Ada Smith");
    await act(async () => { trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger().click(); await Promise.resolve(); });
    await waitFor(() => { expect(onCommit).toHaveBeenCalledTimes(1); expect(onCommit.mock.calls[0]![0]).toEqual([ids.ada]); });
  });

  it("toggles the highlighted person from the keyboard (ArrowDown then Enter) and commits on Escape", async () => {
    await mount();
    await open();
    await waitFor(() => expect(options().length).toBe(4));
    await key(search(), "ArrowDown");
    await key(search(), "Enter");
    await waitFor(() => expect(options().filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(1));
    await closeWithEscape();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toHaveLength(1);
  });

  it("returns focus to the trigger after closing", async () => {
    await mount();
    await open();
    await closeWithEscape();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("hands focus to the trigger before the search input unmounts (asserted at commit time, while the popup is still mounted), so a modal focus manager never sees focus fall to <body> (#368)", async () => {
    await mount();
    await open();
    await waitFor(() => expect(options().length).toBe(4));
    let activeAtCommit: Element | null = null;
    onCommit.mockImplementation(() => { activeAtCommit = document.activeElement; });
    await pick("Ada Smith");
    await closeWithEscape();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(activeAtCommit).toBe(trigger());
    expect(document.activeElement).toBe(trigger());
  });

  it("does not open while disabled", async () => {
    await mount({ disabled: true });
    await act(async () => { trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger().click(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("says so while the people load and when they could not be loaded", async () => {
    let reject!: (error: unknown) => void;
    apiGetMock.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    await mount();
    await open();
    await waitFor(() => expect(document.body.textContent).toContain("Loading people…"));
    await act(async () => { reject(new ApiError("boom", 400)); await Promise.resolve(); });
    await waitFor(() => expect(document.body.textContent).toContain("People could not be loaded."));
  });
});
