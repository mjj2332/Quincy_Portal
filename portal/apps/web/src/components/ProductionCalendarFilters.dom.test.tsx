import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  productionCalendarFiltersSchema,
  STAGE_PRESENTATION_KEYS,
  type CalendarPerson,
  type ProductionCalendarFilters as Filters,
} from "@quincy/shared";
import { ProductionCalendarFilters } from "./ProductionCalendarFilters";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const editorA = "11111111-1111-4111-8111-111111111111";
const editorB = "22222222-2222-4222-8222-222222222222";
const staleEditor = "33333333-3333-4333-8333-333333333333";

const people: CalendarPerson[] = [
  { id: editorA.toUpperCase(), name: "Alex Editor", roleLabel: "Editor", isExternal: false, active: true },
  { id: editorA, name: "Alex Duplicate", roleLabel: "Editor", isExternal: false, active: true },
  { id: editorB, name: "Bea External", roleLabel: "External Editor", isExternal: true, active: false },
];

const defaults: Filters = {
  layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

const stages = [
  { key: "delivered", label: "Delivered" },
  { key: "unknown", label: "Hidden stage" },
  { key: "editing", label: "Editing" },
  { key: "awaiting_raw", label: "Awaiting RAW" },
];

function labelInput(host: HTMLElement, text: string): HTMLInputElement {
  const label = [...host.querySelectorAll("label")].find((candidate) => candidate.textContent?.includes(text));
  if (!label) throw new Error(`Could not find label ${text}`);
  const input = label.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Label ${text} has no input`);
  return input;
}

function fieldset(host: HTMLElement, legend: string): HTMLElement {
  const result = [...host.querySelectorAll("fieldset")].find((candidate) => candidate.querySelector("legend")?.textContent === legend);
  if (!result) throw new Error(`Could not find fieldset ${legend}`);
  return result;
}

function ControlledPanel({ initial, facetPeople = people, panelStages = stages, disabled = false, onChange }: { initial: Filters; facetPeople?: CalendarPerson[]; panelStages?: Array<{ key: string; label: string }>; disabled?: boolean; onChange?: (next: Filters) => void }) {
  const [filters, setFilters] = useState(initial);
  return <ProductionCalendarFilters filters={filters} facetPeople={facetPeople} stages={panelStages} disabled={disabled} onChange={(next) => { onChange?.(next); setFilters(next); }} />;
}

describe("ProductionCalendarFilters", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function renderPanel(initial: Filters = defaults, options: Omit<Parameters<typeof ControlledPanel>[0], "initial"> = {}) {
    const onChange = vi.fn<(next: Filters) => void>();
    act(() => { root.render(<ControlledPanel initial={initial} {...options} onChange={onChange} />); });
    return onChange;
  }

  function expectCanonical(onChange: ReturnType<typeof vi.fn>, expected: Partial<Filters>) {
    const payload = onChange.mock.lastCall?.[0];
    expect(payload).toMatchObject(expected);
    expect(payload).toEqual(productionCalendarFiltersSchema.parse(payload));
  }

  it("emits canonical layer, editor, Unassigned, Stage, and toggle changes", () => {
    const onChange = renderPanel();

    act(() => { labelInput(fieldset(host, "Layers"), "Checklist").click(); });
    expectCanonical(onChange, { layers: ["project"] });

    act(() => { labelInput(fieldset(host, "Editors"), "Alex Editor").click(); });
    expectCanonical(onChange, { editorIds: [editorA] });
    expect(fieldset(host, "Editors").querySelectorAll("input[type=checkbox]")).toHaveLength(3);

    act(() => { labelInput(fieldset(host, "Editors"), "Unassigned").click(); });
    expectCanonical(onChange, { includeUnassigned: true });

    act(() => { labelInput(fieldset(host, "Stages"), "Delivered").click(); });
    expectCanonical(onChange, { stageKeys: ["delivered"] });
    act(() => { labelInput(fieldset(host, "Stages"), "Awaiting RAW").click(); });
    expectCanonical(onChange, { stageKeys: ["awaiting_raw", "delivered"] });

    for (const label of ["Show completed checklist items", "Show delivered projects", "Overdue only", "My tasks"]) {
      act(() => { labelInput(fieldset(host, "Show"), label).click(); });
    }
    expectCanonical(onChange, { showCompletedChecklist: true, showDeliveredProjects: true, overdueOnly: true, myTasks: true });
  });

  it("requires at least one layer", () => {
    const onChange = renderPanel({ ...defaults, layers: ["project"] });
    act(() => { labelInput(fieldset(host, "Layers"), "Projects").click(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(labelInput(fieldset(host, "Layers"), "Projects").checked).toBe(true);
  });

  it("uses only response people, lowercases/deduplicates editor IDs, and never exposes a stale URL ID", () => {
    const onChange = renderPanel({ ...defaults, editorIds: [staleEditor, editorB] });
    expect(host.textContent).toContain("Alex Editor");
    expect(host.textContent).not.toContain("Alex Duplicate");
    expect(host.textContent).not.toContain(staleEditor);
    act(() => { labelInput(fieldset(host, "Editors"), "Alex Editor").click(); });
    expectCanonical(onChange, { editorIds: [editorB, editorA, staleEditor].sort() });
  });

  it("renders only Unassigned and an empty note when the response has no people", () => {
    renderPanel(defaults, { facetPeople: [] });
    const editors = fieldset(host, "Editors");
    expect(editors.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
    expect(editors.textContent).toContain("Unassigned");
    expect(editors.textContent).toContain("No editors in this range");
  });

  it("clears every owned filter while preserving search", () => {
    const onChange = renderPanel({
      layers: ["project"], editorIds: [editorA], includeUnassigned: true, stageKeys: ["editing"],
      showCompletedChecklist: true, showDeliveredProjects: true, overdueOnly: true, search: "smith street", myTasks: true,
    });
    act(() => { host.querySelector<HTMLButtonElement>("button")?.click(); });
    expectCanonical(onChange, { ...defaults, search: "smith street" });
  });

  it("keeps Stage controls in presentation order and disables the whole panel", () => {
    const onChange = renderPanel(defaults, { disabled: true });
    const stageLabels = [...fieldset(host, "Stages").querySelectorAll("label")].map((label) => label.textContent);
    expect(stageLabels).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
    expect(host.querySelector('[aria-label="Calendar filters"]')?.getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelectorAll("input:disabled")).toHaveLength(2 + 3 + 3 + 4);
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    act(() => { labelInput(fieldset(host, "Editors"), "Unassigned").click(); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the shared presentation vocabulary", () => {
    expect(stages.filter(({ key }) => STAGE_PRESENTATION_KEYS.includes(key as typeof STAGE_PRESENTATION_KEYS[number])).map(({ key }) => key)).toEqual(["delivered", "editing", "awaiting_raw"]);
  });
});
