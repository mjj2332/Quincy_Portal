/**
 * #255 — `ProductionGanttFiltersBar`, the Gantt's ReUI `Filters` chip row, in a real render.
 *
 * The harness below stands in for the Dashboard's URL round trip: `onFiltersChange` records the
 * push, and the test decides when the URL "echoes" back through `filters` — at once, or later, so a
 * pending round trip can be observed. Everything is selected by role, accessible name or a Quincy
 * `data-testid`, never by a vendor `data-slot`.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GANTT_FACET_FILTERS, type ProductionGanttFacetFilters, type StageFilterOption } from "../lib/production-gantt-filters";
import { ProductionGanttFiltersBar } from "./ProductionGanttFiltersBar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Base UI's ScrollArea viewport (inside the option menus) calls it; happy-dom has none.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const stageOptions: StageFilterOption[] = [
  { key: "awaiting_raw", label: "Awaiting RAW" },
  { key: "editing", label: "Editing" },
  { key: "delivered", label: "Delivered" },
];

let root: Root | null = null;
let host: HTMLElement;
let pushes: ProductionGanttFacetFilters[];
/** Sets the URL facet the bar reads, as the Dashboard would after a navigation. */
let setUrl: (next: ProductionGanttFacetFilters) => void;
let triggerRefValue: { current: HTMLButtonElement | null };

function Harness({ initial, echo }: { initial: ProductionGanttFacetFilters; echo: boolean }) {
  const [filters, setFilters] = useState(initial);
  setUrl = setFilters;
  return (
    <ProductionGanttFiltersBar
      filters={filters}
      stageOptions={stageOptions}
      triggerRef={triggerRefValue}
      onFiltersChange={(next) => {
        pushes.push(next);
        if (echo) setFilters(next);
      }}
    />
  );
}

async function render(initial: ProductionGanttFacetFilters = DEFAULT_GANTT_FACET_FILTERS, { echo = true } = {}) {
  await act(async () => { root!.render(<Harness initial={initial} echo={echo} />); });
}

/** Real-timer poll — Base UI's open-state transitions land a tick removed from the triggering render. */
async function waitFor(assertion: () => void, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
}

function bar(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="production-gantt-filters"]');
  if (!element) throw new Error("the filters bar is not rendered");
  return element;
}

function addTrigger(): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>('[data-testid="production-gantt-filters-add"]');
  if (!element) throw new Error("the add-filter trigger is not rendered");
  return element;
}

function toolbar(): HTMLElement {
  const element = bar().querySelector<HTMLElement>('[role="toolbar"]');
  if (!element) throw new Error("no toolbar");
  return element;
}

function chips(): HTMLElement[] {
  return [...toolbar().querySelectorAll<HTMLElement>('[role="group"]')];
}

function chipNames(): string[] {
  return chips().map((chip) => chip.getAttribute("aria-label") ?? "");
}

function options(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

function option(name: string): HTMLElement {
  const match = options().find((candidate) => candidate.textContent?.trim() === name);
  if (!match) throw new Error(`no option "${name}" in [${options().map((candidate) => candidate.textContent).join(", ")}]`);
  return match;
}

function button(name: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name);
  if (!match) throw new Error(`no button "${name}"`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

async function press(element: Element, key: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
}

/** Opens the picker, picks the field, its one condition, then the named values. */
async function addFilter(field: "Stage" | "Show", condition: string, values: string[]) {
  await click(addTrigger());
  await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toContain(field));
  await click(option(field));
  await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual([condition]));
  await click(option(condition));
  for (const value of values) {
    await waitFor(() => option(value));
    await click(option(value));
  }
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  pushes = [];
  triggerRefValue = { current: null };
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
});

describe("ProductionGanttFiltersBar (#255)", () => {
  it("renders an empty bar with a labelled Add filter trigger, and seeds chips from the URL", async () => {
    await render();
    expect(toolbar().getAttribute("aria-label")).toBe("Gantt filters");
    expect(chips()).toHaveLength(0);
    expect(addTrigger().textContent).toBe("Add filter");
    expect(addTrigger().hasAttribute("aria-label")).toBe(false);
    expect(triggerRefValue.current).toBe(addTrigger());

    await act(async () => { root!.unmount(); });
    root = createRoot(host);
    await render({ editorIds: [], stageKeys: ["delivered", "awaiting_raw"], delivered: true, completed: true });
    expect(chipNames()).toEqual(["Stage is any of 2 selected", "Show includes 2 selected"]);
    // Icon-only once chips sit beside it, and still named.
    expect(addTrigger().textContent).toBe("");
    expect(addTrigger().getAttribute("aria-label")).toBe("Add filter");
  });

  it("offers exactly Stage and Show, each with one condition, stages with their role-aware labels", async () => {
    await render();
    await click(addTrigger());
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["Stage", "Show"]));
    await click(option("Stage"));
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["is any of"]));
    await click(option("is any of"));
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["Awaiting RAW", "Editing", "Delivered"]));
  });

  it("add -> condition -> value writes the URL; every further toggle writes it again", async () => {
    await render();
    await addFilter("Stage", "is any of", ["Editing"]);
    expect(pushes).toEqual([{ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false }]);
    await click(option("Awaiting RAW"));
    await waitFor(() => expect(pushes).toHaveLength(2));
    expect(pushes[1]).toEqual({ editorIds: [], stageKeys: ["awaiting_raw", "editing"], delivered: false, completed: false });

    await press(document.activeElement ?? document.body, "Escape");
    await settle();
    await addFilter("Show", "includes", ["Completed checklist items", "Delivered projects"]);
    expect(pushes.at(-1)).toEqual({ editorIds: [], stageKeys: ["awaiting_raw", "editing"], delivered: true, completed: true });
    await press(document.activeElement ?? document.body, "Escape");
    await waitFor(() => expect(chipNames()).toEqual(["Stage is any of 2 selected", "Show includes 2 selected"]));
  });

  it("an unfinished chip writes nothing and survives the URL echo of another chip's edit", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false });
    await click(addTrigger());
    await waitFor(() => option("Show"));
    await click(option("Show"));
    await waitFor(() => expect(chipNames()).toEqual(["Stage is any of Editing", "Show Select condition, incomplete filter"]));
    await press(document.activeElement ?? document.body, "Escape");
    await settle();
    expect(pushes).toEqual([]);

    // Edit the finished Stage chip: its push echoes back through the URL.
    await click(button("Editing", toolbar()));
    await waitFor(() => option("Delivered"));
    await click(option("Delivered"));
    await waitFor(() => expect(pushes).toEqual([{ editorIds: [], stageKeys: ["editing", "delivered"], delivered: false, completed: false }]));
    await settle();
    expect(chipNames()).toEqual(["Stage is any of 2 selected", "Show Select condition, incomplete filter"]);
  });

  it("re-seeds from the URL when the URL changes to something the bar does not already say (Back/Forward, reload)", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false });
    const [stageChip] = chips();
    expect(chipNames()).toEqual(["Stage is any of Editing"]);

    // The bar's own echo (equal facet, fresh object): nothing is rebuilt.
    await act(async () => { setUrl({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false }); });
    expect(chips()[0]).toBe(stageChip);

    // A real navigation: the chips follow the URL.
    await act(async () => { setUrl({ editorIds: [], stageKeys: ["awaiting_raw"], delivered: true, completed: false }); });
    expect(chipNames()).toEqual(["Stage is any of Awaiting RAW", "Show includes Delivered projects"]);
    await act(async () => { setUrl(DEFAULT_GANTT_FACET_FILTERS); });
    expect(chips()).toHaveLength(0);
    expect(pushes).toEqual([]);
  });

  it("hides Duplicate and Negate: a chip's menu offers only Remove", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: true, completed: false });
    await click(button("Stage filter options", toolbar()));
    await waitFor(() => expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Remove"]));
  });

  it("disables a field in the picker once a chip for it exists, finished or not", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false });
    await click(addTrigger());
    await waitFor(() => option("Stage"));
    expect(option("Stage").getAttribute("aria-disabled")).toBe("true");
    expect(option("Show").getAttribute("aria-disabled")).not.toBe("true");
    await click(option("Show"));
    await waitFor(() => expect(chips()).toHaveLength(2));
    await press(document.activeElement ?? document.body, "Escape");
    await settle();
    await click(addTrigger());
    await waitFor(() => option("Show"));
    expect(option("Stage").getAttribute("aria-disabled")).toBe("true");
    expect(option("Show").getAttribute("aria-disabled")).toBe("true");
  });

  it("adds by keyboard: Enter on the trigger, then arrows and Enter through field, condition and value", async () => {
    await render();
    const trigger = addTrigger();
    trigger.focus();
    // happy-dom does not synthesise a native button's Enter activation; a browser fires `click`.
    await press(trigger, "Enter");
    await click(trigger);
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["Stage", "Show"]));
    const fieldInput = document.activeElement as HTMLElement;
    expect(fieldInput.getAttribute("role")).toBe("combobox");
    await press(fieldInput, "ArrowDown");
    await press(fieldInput, "Enter");
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["is any of"]));
    const operatorInput = document.activeElement as HTMLElement;
    await press(operatorInput, "ArrowDown");
    await press(operatorInput, "Enter");
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["Awaiting RAW", "Editing", "Delivered"]));
    const valueInput = document.activeElement as HTMLElement;
    await press(valueInput, "ArrowDown");
    await press(valueInput, "Enter");
    await waitFor(() => expect(pushes).toEqual([{ editorIds: [], stageKeys: ["awaiting_raw"], delivered: false, completed: false }]));
  });

  it("removes by keyboard: Delete on a chip moves focus to its neighbour; on the last chip, to the trigger", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: true, completed: false });
    chips()[0]!.focus();
    await press(chips()[0]!, "Delete");
    await waitFor(() => expect(chipNames()).toEqual(["Show includes Delivered projects"]));
    expect(pushes.at(-1)).toEqual({ editorIds: [], stageKeys: [], delivered: true, completed: false });
    await waitFor(() => expect(document.activeElement).toBe(chips()[0]));

    await press(chips()[0]!, "Delete");
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(pushes.at(-1)).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    await waitFor(() => expect(document.activeElement).toBe(addTrigger()));
  });

  it("removing the last chip from its menu hands focus to the trigger", async () => {
    await render({ editorIds: [], stageKeys: [], delivered: false, completed: true });
    await click(button("Show filter options", toolbar()));
    await waitFor(() => expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Remove"]));
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!);
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(pushes).toEqual([DEFAULT_GANTT_FACET_FILTERS]);
    await settle();
    await waitFor(() => expect(document.activeElement).toBe(addTrigger()));
  });

  it("the bar's own Clear writes the default facet and hands focus to the trigger", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: true, completed: true });
    const clear = button("Clear", bar());
    clear.focus();
    await click(clear);
    await waitFor(() => expect(chips()).toHaveLength(0));
    expect(pushes).toEqual([DEFAULT_GANTT_FACET_FILTERS]);
    expect(bar().textContent).not.toContain("Clear");
    await waitFor(() => expect(document.activeElement).toBe(addTrigger()));
  });

  it("keeps focus on the control in use while the URL round trip is pending, and after it lands", async () => {
    await render(DEFAULT_GANTT_FACET_FILTERS, { echo: false });
    await addFilter("Stage", "is any of", ["Editing"]);
    expect(pushes).toEqual([{ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false }]);
    await settle();
    const focused = document.activeElement;
    expect(focused).not.toBe(document.body);
    expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
    const [chip] = chips();

    // The URL lands later, equal to what the bar already says.
    await act(async () => { setUrl(pushes[0]!); });
    await settle();
    expect(document.activeElement).toBe(focused);
    expect(chips()[0]).toBe(chip);
    expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["Awaiting RAW", "Editing", "Delivered"]);
  });
});
