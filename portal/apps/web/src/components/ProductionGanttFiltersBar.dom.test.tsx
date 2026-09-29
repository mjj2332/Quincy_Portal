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
import type { CalendarPerson } from "@quincy/shared";
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

const ALEX = "0a000000-0000-4000-8000-000000000001";
const BEA = "0b000000-0000-4000-8000-000000000002";
const STALE = "0c000000-0000-4000-8000-000000000003";
const people: CalendarPerson[] = [
  { id: BEA, name: "Bea Editor", roleLabel: "Editor", isExternal: false, active: true },
  { id: ALEX.toUpperCase(), name: "Alex Admin", roleLabel: "Admin", isExternal: false, active: true },
];
let barPeople: readonly CalendarPerson[] = [];

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
      people={barPeople}
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

/** An option's spoken label: its text without the decorative (`aria-hidden`) icon, e.g. an avatar's initials. */
function optionLabel(candidate: HTMLElement): string {
  const copy = candidate.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
  return copy.textContent?.trim() ?? "";
}

function option(name: string): HTMLElement {
  const match = options().find((candidate) => optionLabel(candidate) === name);
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
async function addFilter(field: "Stage" | "Show" | "Editor", condition: string, values: string[]) {
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
  barPeople = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
});

describe("ProductionGanttFiltersBar: the Editor field (#274)", () => {
  it("offers Editor first, once the server has listed people, each with an initials avatar", async () => {
    barPeople = people;
    await render();
    await click(addTrigger());
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["Editor", "Stage", "Show"]));
    await click(option("Editor"));
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["is any of"]));
    await click(option("is any of"));
    await waitFor(() => option("Alex Admin"));
    expect(options().map(optionLabel)).toEqual(["Bea Editor", "Alex Admin"]);
    expect(options().map((candidate) => candidate.querySelector('[aria-hidden="true"]')?.textContent)).toEqual(["BE", "AA"]);
    // The highlighted row paints --accent (ink), the avatar's own fill: a paper ring keeps its circle
    // visible there (#274 design review).
    const avatar = options()[0]!.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    expect(avatar.className).toContain("[[data-highlighted]_&]:ring-1");
    expect(avatar.className).toContain("[[data-highlighted]_&]:ring-[var(--paper-050)]");
  });

  it("writes the picked editors as sorted lowercase ids, independent of Stage and Show", async () => {
    barPeople = people;
    await render({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false });
    await addFilter("Editor", "is any of", ["Bea Editor"]);
    expect(pushes.at(-1)).toEqual({ editorIds: [BEA], stageKeys: ["editing"], delivered: false, completed: false });
    await click(option("Alex Admin"));
    await waitFor(() => expect(pushes.at(-1)).toEqual({ editorIds: [ALEX, BEA], stageKeys: ["editing"], delivered: false, completed: false }));
  });

  it("renders an editor id the server no longer lists as 'Unknown editor (not applied)', which can still be removed", async () => {
    barPeople = people;
    await render({ editorIds: [STALE], stageKeys: [], delivered: false, completed: false });
    expect(chipNames()).toEqual(["Editor is any of Unknown editor (not applied)"]);
    await click(button("Unknown editor (not applied)", chips()[0]!));
    await waitFor(() => expect(option("Unknown editor (not applied)").getAttribute("aria-selected")).toBe("true"));
    await click(option("Unknown editor (not applied)"));
    await waitFor(() => expect(pushes.at(-1)?.editorIds).toEqual([]));
  });

  it("does not offer Editor while there is nobody to pick", async () => {
    await render();
    await click(addTrigger());
    await waitFor(() => expect(options().map((candidate) => candidate.textContent?.trim())).toEqual(["Stage", "Show"]));
  });
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

  it("draws the selected option's tick in the row's own colour, so it survives the ink highlight (browser pass F)", async () => {
    await render();
    await addFilter("Stage", "is any of", ["Editing"]);
    await waitFor(() => expect(option("Editing").getAttribute("aria-selected")).toBe("true"));
    // The stage swatch is a <span>, so the one <svg> in a row is its tick.
    const ticks = option("Editing").querySelectorAll("svg");
    expect(ticks).toHaveLength(1);
    const tick = ticks[0]!;
    // An unselected row draws no tick at all.
    expect(option("Delivered").querySelectorAll("svg")).toHaveLength(0);
    // No forced foreground: the highlighted row is `bg-accent` (--ink-900) with `text-accent-foreground`
    // on its descendants, and a tick pinned to `text-foreground!` drew ink on ink. It inherits instead.
    const classes = (tick.getAttribute("class") ?? "").split(/\s+/);
    expect(classes.filter((name) => name.includes("text-foreground"))).toEqual([]);
    expect(tick.getAttribute("stroke")).toBe("currentColor");
  });

  it("sizes a chip to the Add filter and Clear buttons: the Quincy Button's 38px / 44px (<=721px) height contract (browser pass F)", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false });
    const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
    // Read off the real trigger, so the chip is tied to the Button's contract rather than to literals.
    const heightContract = tokens(addTrigger()).filter((name) => /(^|:)min-h-/.test(name));
    expect(heightContract).toEqual(["min-h-[38px]", "max-[721px]:min-h-[44px]"]);
    expect(tokens(button("Clear", bar())).filter((name) => /(^|:)min-h-/.test(name))).toEqual(heightContract);

    const [chip] = chips();
    // The chip is an items-stretch group, so its height lifts the text segments; the kebab carries an
    // explicit `size-*` height, so it needs the contract itself or it stays 32px inside a taller pill.
    for (const element of [chip!, button("Stage filter options", chip!)]) {
      for (const name of heightContract) expect(tokens(element)).toContain(name);
    }
  });

  it("widens both value menus past the vendored 12rem, so 'Completed checklist items' and the longer stage labels are not truncated (browser pass F)", async () => {
    /** The width utility on the nearest ancestor of a menu row that sets one: the value panel. */
    const panelWidth = (row: HTMLElement) => {
      for (let element = row.parentElement; element; element = element.parentElement) {
        const width = (element.getAttribute("class") ?? "").split(/\s+/).find((name) => /^w-\d+$/.test(name));
        if (width) return width;
      }
      return null;
    };
    await render();
    await addFilter("Stage", "is any of", ["Editing"]);
    expect(panelWidth(option("Editing"))).toBe("w-60");
    await press(document.activeElement ?? document.body, "Escape");
    await settle();
    await addFilter("Show", "includes", ["Completed checklist items"]);
    expect(panelWidth(option("Completed checklist items"))).toBe("w-60");
  });

  it("rounds every focusable chip segment's focus ring to the chip's 14px radius, like the Add filter ring (browser pass F)", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false });
    const [chip] = chips();
    const segments = [...chip!.querySelectorAll<HTMLElement>("button")];
    // Operator, value, kebab: the three a keyboard lands on.
    expect(segments.map((segment) => segment.getAttribute("aria-label") ?? segment.textContent?.trim())).toEqual(["is any of", "Editing", "Stage filter options"]);
    // The global `:focus-visible` outline follows `border-radius`, and ButtonGroup squares the inner
    // corners of every segment, so a focused segment drew a square ring on a rounded pill. On focus
    // the segment takes the chip's radius token (`--radius-lg`, what `rounded-lg` resolves to on the
    // Add filter trigger), `!` to beat ButtonGroup's child-combinator corner resets.
    for (const segment of segments) expect((segment.getAttribute("class") ?? "").split(/\s+/)).toContain("focus-visible:rounded-(--radius-lg)!");
  });

  it("draws a finished chip's operator in the secondary text role, which clears 4.5:1 on the resting and hover fills (browser pass G)", async () => {
    await render({ editorIds: [], stageKeys: ["editing"], delivered: true, completed: false });
    const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
    // `text-muted-foreground` (--text-muted, greige-400) measured 3.13:1 on the `hover:bg-muted`
    // fill (--paper-100) and 3.36:1 at rest (--paper-050). `text-foreground-secondary`
    // (--text-secondary, greige-600) is 8.66:1 at rest and 8.09:1 on hover.
    for (const operator of [button("is any of", toolbar()), button("includes", toolbar())]) {
      expect(tokens(operator)).toContain("text-foreground-secondary");
      expect(tokens(operator)).not.toContain("text-muted-foreground");
      expect(tokens(operator)).toContain("hover:bg-muted");
      expect(tokens(operator)).toContain("bg-background");
    }
  });

  it("keeps a chip's value on one line, truncated under a max width, with the full value in its name (browser pass G)", async () => {
    // Stage carries a single value with a swatch icon; Show a single long value with none.
    await render({ editorIds: [], stageKeys: ["awaiting_raw"], delivered: false, completed: true });
    const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
    for (const name of ["Awaiting RAW", "Completed checklist items"]) {
      const segment = button(name, toolbar());
      // At 390x844 "Completed checklist items" wrapped and made the chip 62px tall.
      for (const utility of ["whitespace-nowrap", "min-w-0", "max-w-60"]) expect(tokens(segment)).toContain(utility);
      // The text itself sits in a truncating box, so it ellipsizes instead of overflowing the segment.
      const text = [...segment.querySelectorAll<HTMLElement>("span")].find((span) => span.textContent === name && tokens(span).includes("truncate"));
      expect(text, `a truncating span holding "${name}"`).toBeDefined();
    }
    expect(chipNames()).toEqual(["Stage is any of Awaiting RAW", "Show includes Completed checklist items"]);
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
    await waitFor(() => option("Awaiting RAW"));
    await click(option("Awaiting RAW"));
    await waitFor(() => expect(pushes).toEqual([{ editorIds: [], stageKeys: ["awaiting_raw", "editing"], delivered: false, completed: false }]));
    await settle();
    expect(chipNames()).toEqual(["Stage is any of 2 selected", "Show Select condition, incomplete filter"]);
  });

  describe("the Delivered pair: Stage = Delivered switches Show -> Delivered on (owner decision)", () => {
    it("selecting Delivered on the Stage chip writes one facet with delivered projects on, and the Show chip shows it", async () => {
      await render({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false });
      await click(button("Editing", toolbar()));
      await waitFor(() => option("Delivered"));
      await click(option("Delivered"));
      await waitFor(() => expect(pushes).toHaveLength(1));
      expect(pushes).toEqual([{ editorIds: [], stageKeys: ["editing", "delivered"], delivered: true, completed: false }]);
      await press(document.activeElement ?? document.body, "Escape");
      await settle();
      expect(chipNames()).toEqual(["Stage is any of 2 selected", "Show includes Delivered projects"]);
      expect(pushes).toHaveLength(1);
    });

    it("keeps Show -> Completed when selecting Delivered adds Delivered to the Show chip", async () => {
      await render({ editorIds: [], stageKeys: ["editing"], delivered: false, completed: true });
      await click(button("Editing", toolbar()));
      await waitFor(() => option("Delivered"));
      await click(option("Delivered"));
      await waitFor(() => expect(pushes).toHaveLength(1));
      expect(pushes).toEqual([{ editorIds: [], stageKeys: ["editing", "delivered"], delivered: true, completed: true }]);
      await press(document.activeElement ?? document.body, "Escape");
      await settle();
      expect(chipNames()).toEqual(["Stage is any of 2 selected", "Show includes 2 selected"]);
    });

    it("turning Show -> Delivered off while Stage holds Delivered and another stage writes one facet with only the other stage", async () => {
      await render({ editorIds: [], stageKeys: ["editing", "delivered"], delivered: true, completed: false });
      await click(button("Delivered projects", toolbar()));
      await waitFor(() => option("Delivered projects"));
      await click(option("Delivered projects"));
      await waitFor(() => expect(pushes).toHaveLength(1));
      expect(pushes).toEqual([{ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false }]);
      await settle();
      expect(chipNames()[0]).toBe("Stage is any of Editing");
      expect(pushes).toHaveLength(1);
    });

    it("removing the Show chip when Delivered is the only stage drops the Stage chip too", async () => {
      await render({ editorIds: [], stageKeys: ["delivered"], delivered: true, completed: false });
      expect(chipNames()).toEqual(["Stage is any of Delivered", "Show includes Delivered projects"]);
      await click(button("Show filter options", toolbar()));
      await waitFor(() => expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Remove"]));
      await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!);
      await waitFor(() => expect(chips()).toHaveLength(0));
      expect(pushes).toEqual([DEFAULT_GANTT_FACET_FILTERS]);
      await waitFor(() => expect(document.activeElement).toBe(addTrigger()));
    });

    it("never rewrites a cold URL holding Stage = Delivered with delivered projects hidden", async () => {
      await render({ editorIds: [], stageKeys: ["delivered"], delivered: false, completed: false });
      await settle();
      expect(chipNames()).toEqual(["Stage is any of Delivered"]);
      expect(pushes).toEqual([]);
    });
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

  it("writes a second edit made before the first write's URL lands, and the stale URL does not revert it (Sol review)", async () => {
    await render(DEFAULT_GANTT_FACET_FILTERS, { echo: false });
    await addFilter("Stage", "is any of", ["Editing"]);
    expect(pushes).toEqual([{ editorIds: [], stageKeys: ["editing"], delivered: false, completed: false }]);

    // Deselect it again while the first write is still in flight: the bar must write the default.
    await click(option("Editing"));
    await waitFor(() => expect(pushes).toHaveLength(2));
    expect(pushes[1]).toEqual(DEFAULT_GANTT_FACET_FILTERS);
    await settle();
    const chipsAfterSecondEdit = chipNames();
    expect(chipsAfterSecondEdit.join(" ")).not.toContain("Editing");

    // The first write's URL lands late: it is the bar's own stale echo, so nothing reverts.
    await act(async () => { setUrl(pushes[0]!); });
    await settle();
    expect(chipNames()).toEqual(chipsAfterSecondEdit);
    expect(pushes).toHaveLength(2);

    // Then the second write's URL: the bar already says it.
    await act(async () => { setUrl(pushes[1]!); });
    await settle();
    expect(chipNames()).toEqual(chipsAfterSecondEdit);
    expect(pushes).toHaveLength(2);
  });

  it("still re-seeds from an outside navigation that lands while its own write is in flight", async () => {
    await render(DEFAULT_GANTT_FACET_FILTERS, { echo: false });
    await addFilter("Stage", "is any of", ["Editing"]);
    expect(pushes).toHaveLength(1);
    await press(document.activeElement ?? document.body, "Escape");
    await settle();

    // Back/Forward to a URL the bar never wrote, before its own write lands.
    await act(async () => { setUrl({ editorIds: [], stageKeys: ["awaiting_raw"], delivered: true, completed: false }); });
    await settle();
    expect(chipNames()).toEqual(["Stage is any of Awaiting RAW", "Show includes Delivered projects"]);
    expect(pushes).toHaveLength(1);
  });

  it("updates the live status when an outside change re-seeds the bar, e.g. the empty state's Clear filters (browser pass G)", async () => {
    const status = () => {
      const element = bar().querySelector<HTMLElement>('[role="status"][aria-live="polite"]');
      if (!element) throw new Error("no live status region");
      return element.textContent?.trim();
    };
    await render();
    await addFilter("Stage", "is any of", ["Editing"]);
    await press(document.activeElement ?? document.body, "Escape");
    await settle();
    expect(chips()).toHaveLength(1);
    expect(status()).toBe("1 filter applied");
    const pushed = pushes.length;

    // An outside reseed: the chips follow the URL, and so must the status.
    await act(async () => { setUrl(DEFAULT_GANTT_FACET_FILTERS); });
    await settle();
    expect(chips()).toHaveLength(0);
    expect(status()).toBe("0 filters applied");

    await act(async () => { setUrl({ editorIds: [], stageKeys: ["awaiting_raw"], delivered: true, completed: false }); });
    await settle();
    expect(chips()).toHaveLength(2);
    expect(status()).toBe("2 filters applied");
    // Announcing is not writing: an outside reseed never pushes back.
    expect(pushes).toHaveLength(pushed);
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
