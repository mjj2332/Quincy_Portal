/**
 * #222 step 6 — the event-calendar rail's filters: Layers and People as `reui/combobox` chips, and
 * "N filters active · Clear" for the URL-only filters. Ports `ProductionCalendarFilters.dom.test.tsx`
 * (canonical payloads, ≥1 layer, response-only people, stale URL ids, Clear preserves search).
 * Guard F: no vendor `data-slot` selectors — Quincy `data-testid`s and accessible names only.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productionCalendarFiltersSchema, type ProductionCalendarFilters as Filters } from "@quincy/shared";
import { ProductionEventCalendarFacets } from "./ProductionEventCalendarFacets";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const editorA = "11111111-1111-4111-8111-111111111111";

const defaults: Filters = {
  layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const,
  shootRange: null, deadlineRange: null,
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
};

function Controlled({ initial, disabled = false, onChange }: { initial: Filters; disabled?: boolean; onChange: (next: Filters) => void }) {
  const [filters, setFilters] = useState(initial);
  return <ProductionEventCalendarFacets filters={filters} disabled={disabled} onChange={(next) => { onChange(next); setFilters(next); }} />;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); document.body.replaceChildren(); });

async function renderFacets(initial: Filters = defaults, options: { disabled?: boolean } = {}) {
  const onChange = vi.fn<(next: Filters) => void>();
  await act(async () => { root.render(<Controlled initial={initial} {...options} onChange={onChange} />); await Promise.resolve(); });
  return onChange;
}

function expectCanonical(onChange: ReturnType<typeof vi.fn>, expected: Partial<Filters>) {
  const payload = onChange.mock.lastCall?.[0];
  expect(payload).toMatchObject(expected);
  expect(payload).toEqual(productionCalendarFiltersSchema.parse(payload));
}

async function waitFor(assertion: () => void) {
  let last: unknown;
  for (let i = 0; i < 20; i += 1) {
    try { assertion(); return; } catch (error) { last = error; }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw last;
}

async function openPicker(label: string) {
  const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.focus(); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
}

function option(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`No option ${text}`);
  return found;
}

function chipIds(prefix: string): string[] {
  return [...host.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)].map((chip) => chip.dataset.testid!).filter((id) => !id.endsWith("-remove"));
}

async function removeChip(testId: string) {
  const chip = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  await act(async () => { chip.querySelector<HTMLButtonElement>('[data-testid="event-calendar-chip-remove"]')!.click(); await Promise.resolve(); });
}

describe("ProductionEventCalendarFacets — Layers", () => {
  it("shows a chip per selected layer and emits a canonical payload when one is removed", async () => {
    const onChange = await renderFacets();
    expect(chipIds("event-calendar-layer-")).toEqual(["event-calendar-layer-project", "event-calendar-layer-checklist"]);
    // Issue #222's copy: the Layers combobox reads "Project deadlines / Checklist tasks".
    expect(host.querySelector('[data-testid="event-calendar-layer-project"]')?.textContent).toBe("Project deadlines");
    expect(host.querySelector('[data-testid="event-calendar-layer-checklist"]')?.textContent).toBe("Checklist tasks");
    expect(host.querySelector('[aria-label="Remove Checklist tasks"]')).not.toBeNull();
    await removeChip("event-calendar-layer-checklist");
    expectCanonical(onChange, { layers: ["project"] });
    expect(chipIds("event-calendar-layer-")).toEqual(["event-calendar-layer-project"]);
  });

  it("keeps at least one layer selected", async () => {
    const onChange = await renderFacets({ ...defaults, layers: ["project"] });
    await removeChip("event-calendar-layer-project");
    expect(onChange).not.toHaveBeenCalled();
    expect(chipIds("event-calendar-layer-")).toEqual(["event-calendar-layer-project"]);
  });

  it("adds a layer back from the list, in canonical order", async () => {
    const onChange = await renderFacets({ ...defaults, layers: ["checklist"] });
    await openPicker("Add layer");
    await act(async () => { option("Project deadlines").click(); await Promise.resolve(); });
    expectCanonical(onChange, { layers: ["project", "checklist"] });
  });
});

describe("ProductionEventCalendarFacets — People moved to the shared Filter (#429)", () => {
  it("has no People picker and no person chip", async () => {
    await renderFacets({ ...defaults, editorIds: [editorA], includeUnassigned: true });
    expect(host.querySelector('[aria-label="Filter people"]')).toBeNull();
    expect(chipIds("event-calendar-person-")).toEqual([]);
  });
});

describe("ProductionEventCalendarFacets — hidden URL filters", () => {
  it("is absent when no URL-only filter is active", async () => {
    await renderFacets();
    expect(host.querySelector('[data-testid="event-calendar-hidden-filters"]')).toBeNull();
  });

  it("counts Completed and Delivered only (the shared Filter owns the rest), and Clear resets only those", async () => {
    const onChange = await renderFacets({
      layers: ["project"], editorIds: [editorA], includeUnassigned: true, stageKeys: ["editing", "delivered"], priorities: [], archived: "hide" as const,
      shootRange: null, deadlineRange: null,
      showCompletedChecklist: true, showDeliveredProjects: true, overdueOnly: true, search: "smith street", myTasks: true,
    });
    expect(host.querySelector('[data-testid="event-calendar-hidden-filters"]')?.textContent).toContain("2 filters active");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-hidden-filters-clear"]')!.click(); await Promise.resolve(); });
    expectCanonical(onChange, {
      layers: ["project"], editorIds: [editorA], includeUnassigned: true, stageKeys: ["editing", "delivered"], priorities: [], archived: "hide" as const,
      shootRange: null, deadlineRange: null,
      showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: true, search: "smith street", myTasks: true,
    });
    expect(host.querySelector('[data-testid="event-calendar-hidden-filters"]')).toBeNull();
  });

  it("says 1 filter active in the singular", async () => {
    await renderFacets({ ...defaults, showCompletedChecklist: true });
    expect(host.querySelector('[data-testid="event-calendar-hidden-filters"]')?.textContent).toContain("1 filter active");
  });
});

describe("ProductionEventCalendarFacets — disabled", () => {
  it("disables the picker, every chip remove and Clear", async () => {
    const onChange = await renderFacets({ ...defaults, showDeliveredProjects: true }, { disabled: true });
    expect(host.querySelector<HTMLInputElement>('[aria-label="Add layer"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-hidden-filters-clear"]')?.disabled).toBe(true);
    await removeChip("event-calendar-layer-checklist");
    expect(onChange).not.toHaveBeenCalled();
  });
});
