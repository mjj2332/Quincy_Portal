/**
 * Every piece of text inside every Production chip stays readable in every state the chip can be
 * drawn in — rest, hover, selected, selected + hover — in all five Production views (month, week,
 * day, 3-day `days`, agenda), through the REAL vendored event calendar.
 *
 * WHY. The chip's class is `cn(vendor tint, eventClassName)`, and tailwind-merge drops a vendor
 * utility only when the consumer supplies the SAME variant. A state the consumer forgets keeps the
 * vendor's `--ec-event-color` wash under the consumer's text colour. That shipped twice: a selected
 * Deadline drew ink-900/30 under paper text (2.03:1), and a hovered agenda Deadline row took the
 * agenda row's `hover:bg-muted` — paper on paper (1.07:1). Each class string looked right on its
 * own; only the MERGED class shows the defect, so this reads the real merged `className` off the
 * rendered chip and resolves it against the live token files.
 *
 * WHAT IS MEASURED. Every element inside the chip (the chip included) that owns a non-empty text
 * node: its surviving `text-*` colour utility, inherited from the nearest ancestor within the chip
 * when it has none, and resolved through any custom-property re-scope on the chip or an ancestor
 * within it (the Deadline's dark-surface `--muted-foreground`). It is measured against the chip's
 * effective fill for each state over each paper ground (in the agenda, where a row is never
 * selected, rest and hover only). An element with its own opaque fill (the assignee avatar) is
 * measured against that fill instead. Known failures that are NOT this chip's to fix sit in
 * `CONTRAST_BASELINE`, keyed narrowly; the baseline may only shrink, and Deadline chips may never
 * appear in it.
 *
 * happy-dom computes no real colour, so the resolver models the cascade from the class list (the
 * rules are spelled out in `effectiveBackgrounds`) and composites alpha in sRGB — an approximation
 * of Tailwind v4's `color-mix(in oklab)`, but every margin here is far from the 4.5:1 threshold.
 * Opacity utilities are not modelled. The self-tests at the bottom feed it the pre-fix classes and
 * require it to fail them.
 *
 * SELECTOR NOTE. Chips are located by `data-ec-event-id`, a Quincy-added attribute on the vendored
 * chip (QUINCY EDIT LOG #4 in `event-calendar-event.tsx`), not by the vendor's own `data-slot`
 * (guard F) — and agenda rows do not go through `renderEvent`, so the Quincy chip testid is absent
 * there.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState } from "@quincy/shared";
import { ProductionEventCalendar } from "./ProductionEventCalendar";
import { DEADLINE_AGENDA_DOT } from "../lib/production-event-calendar-adapter";
import { startMoment, endMoment } from "@/testing/subtask-schedule";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));

// ---------------------------------------------------------------------------------------------
// Token resolution: top-level `:root` / `@theme` declarations of the live token files only.
// ---------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
type Rgb = readonly [number, number, number];

function topLevelDeclarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  let selector = "";
  let body = "";
  let head = "";
  for (const char of source) {
    if (char === "{") {
      if (depth === 0) { selector = head.trim(); body = ""; head = ""; }
      else body += char;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (selector === ":root" || selector.startsWith("@theme")) {
          for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(match[1]!, match[2]!.trim());
        }
      } else body += char;
    } else if (depth === 0) head += char;
    else body += char;
  }
  return out;
}

const TOKENS = new Map([
  ...topLevelDeclarations(readFileSync(join(here, "../styles/tokens/colors.css"), "utf8")),
  ...topLevelDeclarations(readFileSync(join(here, "../styles/tokens/tailwind.css"), "utf8")),
]);

function resolveVar(name: string, extra: Map<string, string>, seen: string[] = []): Rgb {
  if (seen.includes(name)) throw new Error(`var() cycle: ${[...seen, name].join(" → ")}`);
  const value = extra.get(name) ?? TOKENS.get(name);
  if (value === undefined) throw new Error(`unknown token ${name}`);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255) as unknown as Rgb;
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return resolveVar(ref[1]!, extra, [...seen, name]);
  throw new Error(`${name} resolves to ${value}, which this resolver cannot read`);
}

type Paint = { rgb: Rgb; alpha: number };

/**
 * `bg-(--x)/NN`, `bg-[var(--x)]`, `text-[color:var(--x)]`, `bg-muted`, `text-foreground-secondary`…
 * → a colour, or null for a non-colour utility (`text-sm`, `text-[length:12px]`). An arbitrary
 * value this cannot read throws rather than being skipped.
 */
function paintOf(utility: string, kind: "bg" | "text" | "inset-ring", extra: Map<string, string>): Paint | null {
  const match = new RegExp(`^${kind}-(.+?)(?:/(\\d+))?$`).exec(utility);
  if (!match) return null;
  const alpha = match[2] ? Number(match[2]) / 100 : 1;
  const value = match[1]!;
  if (value.startsWith("[length:")) return null;
  const arbitrary = /^\((--[\w-]+)\)$/.exec(value) ?? /^\[(?:color:)?var\((--[\w-]+)\)\]$/.exec(value);
  if (!arbitrary && value.startsWith("[")) throw new Error(`cannot read the arbitrary value in ${kind}-${value}`);
  const name = arbitrary ? arbitrary[1]! : `--color-${value}`;
  if (!arbitrary && !TOKENS.has(name)) return null;
  return { rgb: resolveVar(name, extra), alpha };
}

const over = (paint: Paint, ground: Rgb): Rgb => paint.rgb.map((c, i) => paint.alpha * c + (1 - paint.alpha) * ground[i]!) as unknown as Rgb;
const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const GROUNDS = ["--paper-000", "--paper-050", "--paper-100"] as const;
const STATES = ["rest", "hover", "selected", "selected+hover"] as const;
type State = (typeof STATES)[number];
type View = "month" | "week" | "day" | "days" | "agenda";

/** The last utility with exactly this variant prefix that resolves to a colour. */
function lastPaint(classes: string[], prefix: string, kind: "bg" | "text" | "inset-ring", extra: Map<string, string>): Paint | null {
  let found: Paint | null = null;
  for (const token of classes) {
    if (!token.startsWith(prefix)) continue;
    const paint = paintOf(token.slice(prefix.length), kind, extra);
    if (paint) found = paint;
  }
  return found;
}

/**
 * rest = unprefixed `bg-*`; hover = `hover:bg-*` ?? rest (in agenda, `data-[view=agenda]:hover:bg-*`
 * first — it wins on specificity over the row's `hover:bg-muted`); selected = `data-selected:bg-*`
 * ?? rest; selected+hover = `data-selected:hover:bg-*` ?? selected (Tailwind v4 emits data-* after
 * hover at equal specificity). No fill at all = the ground shows through.
 */
function effectiveBackgrounds(classes: string[], view: View, extra: Map<string, string>): Record<State, Paint | null> {
  const bg = (prefix: string) => lastPaint(classes, prefix, "bg", extra);
  const rest = bg("");
  const hover = (view === "agenda" ? bg("data-[view=agenda]:hover:") : null) ?? bg("hover:") ?? rest;
  const selected = bg("data-selected:") ?? rest;
  const selectedHover = bg("data-selected:hover:") ?? selected;
  return { rest, hover, selected, "selected+hover": selectedHover };
}

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const extraFor = (eventColor: string | null) => new Map<string, string>(eventColor ? [["--ec-event-color", eventColor]] : []);

type TextElement = { descriptor: string; text: Paint | null; ownFill: Paint | null };
type Measurement = { key: string; tuple: string; ratio: number };

/** A stable, narrow name for a text element: `chip`, its testid, or its tag plus first three classes. */
function descriptorOf(el: HTMLElement, chip: HTMLElement): string {
  if (el === chip) return "chip";
  const testid = el.getAttribute("data-testid");
  if (testid) return `[data-testid=${testid}]`;
  return [el.tagName.toLowerCase(), ...classesOf(el).slice(0, 3)].join(".");
}

/**
 * Custom-property re-scopes (`[--muted-foreground:var(--greige-300)]`) on the chip and on the
 * element's ancestors within it, nearer overriding farther — how a role like
 * `text-muted-foreground` (`color: var(--muted-foreground)`) resolves at that element.
 */
function scopedExtra(el: HTMLElement, chip: HTMLElement, base: Map<string, string>): Map<string, string> {
  const chain: HTMLElement[] = [];
  for (let at: HTMLElement | null = el; at; at = at === chip ? null : at.parentElement) chain.unshift(at);
  const extra = new Map(base);
  for (const at of chain) {
    for (const token of classesOf(at)) {
      const match = /^\[(--[\w-]+):(var\(--[\w-]+\))\]$/.exec(token);
      if (match) extra.set(match[1]!, match[2]!);
    }
  }
  return extra;
}

/**
 * Every element in the chip that owns a non-empty text node. Text colour: its own surviving
 * `text-*` colour utility, else the nearest ancestor's within the chip. Own fill: the nearest
 * unprefixed `bg-*` on it or an ancestor BELOW the chip (the chip's fill is per state, resolved
 * separately).
 */
function textElements(chip: HTMLElement, base: Map<string, string>): TextElement[] {
  const out: TextElement[] = [];
  for (const el of [chip, ...chip.querySelectorAll<HTMLElement>("*")]) {
    if (![...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())) continue;
    const extra = scopedExtra(el, chip, base);
    let text: Paint | null = null;
    let ownFill: Paint | null = null;
    for (let at: HTMLElement | null = el; at; at = at === chip ? null : at.parentElement) {
      text ??= lastPaint(classesOf(at), "", "text", extra);
      if (at !== chip) ownFill ??= lastPaint(classesOf(at), "", "bg", extra);
    }
    out.push({ descriptor: descriptorOf(el, chip), text, ownFill });
  }
  return out;
}

/**
 * The text contrast of every text element × state × ground. A class string (the self-tests) is
 * measured as a chip whose only text is its own.
 */
function measure(label: string, chip: HTMLElement | string, view: View, eventColor: string | null): Measurement[] {
  const extra = extraFor(eventColor);
  const classes = typeof chip === "string" ? chip.split(/\s+/).filter(Boolean) : classesOf(chip);
  const backgrounds = effectiveBackgrounds(classes, view, extra);
  const elements = typeof chip === "string" ? [{ descriptor: "chip", text: lastPaint(classes, "", "text", extra), ownFill: null }] : textElements(chip, extra);
  if (elements.length === 0) throw new Error(`${label} × ${view}: the chip renders no text`);
  const out: Measurement[] = [];
  for (const { descriptor, text, ownFill } of elements) {
    const key = `${label} × ${view} × ${descriptor}`;
    if (!text) throw new Error(`${key}: no text colour utility on the element or any ancestor within the chip`);
    // An agenda row is never selected (the vendor's `isSelected` is false there — pinned by the
    // week → agenda test below), so only rest and hover are reachable in the agenda.
    for (const state of view === "agenda" ? (["rest", "hover"] as const) : STATES) {
      for (const groundName of GROUNDS) {
        const ground = resolveVar(groundName, extra);
        const paint = backgrounds[state];
        const chipFill = paint ? over(paint, ground) : ground;
        const fill = ownFill ? over(ownFill, chipFill) : chipFill;
        out.push({ key, tuple: `${key} × ${state} × ${groundName}`, ratio: contrast(over(text, fill), fill) });
      }
    }
  }
  return out;
}

const failuresOf = (measurements: Measurement[]) => measurements.filter(({ ratio }) => ratio < 4.5);
const describeFailure = ({ tuple, ratio }: Measurement) => `${tuple}: ${ratio.toFixed(2)}:1`;

/**
 * Known failures, NOT fixed by this chip's class and not to be fixed here. Keyed
 * `<chip> × <view> × <element>`; every state and ground of that key is covered. Deadline chips may
 * never appear here.
 *
 * The vendored agenda row's time column (`event-calendar-event.tsx`, the `agendaDefaultContent`
 * span) is `text-muted-foreground`, which is the app-wide `--text-muted` token (greige-400). On a
 * paper checklist row it measures under 4.5:1. That is a token-level decision for the whole app,
 * not this chip, and is tracked as a follow-up.
 */
const CONTRAST_BASELINE: Record<string, string> = {
  "active checklist × agenda × span.text-muted-foreground.w-40.shrink-0": "--text-muted on a paper agenda row: 3.57:1 rest, 3.13:1 hover — follow-up",
  "done checklist × agenda × span.text-muted-foreground.w-40.shrink-0": "--text-muted on the done wash: 2.86–3.16:1 rest, 3.13:1 hover — follow-up",
};

type Band = { paint: Paint; width: number };

/**
 * The selected state's inset keyline bands actually EXPOSED, from the chip edge inwards. Tailwind
 * composes `box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), …`; the first layer
 * paints on top, and every inset layer starts at the edge, so a lower layer shows only for the
 * width by which it exceeds the layers above it.
 *   inset shadow: `data-selected:inset-shadow-[0_0_0_Npx_var(--x)]`
 *   inset ring:   width `data-selected:inset-ring-N` ?? `inset-ring-N` ?? `inset-ring` (1px) ?? none;
 *                 colour `data-selected:inset-ring-<colour>` ?? `inset-ring-<colour>`.
 */
function exposedBands(classes: string[], extra: Map<string, string>): Band[] {
  let shadow: Band | null = null;
  for (const token of classes) {
    const match = /^data-selected:inset-shadow-\[0_0_0_(\d+(?:\.\d+)?)px_var\((--[\w-]+)\)\]$/.exec(token);
    if (match) shadow = { paint: { rgb: resolveVar(match[2]!, extra), alpha: 1 }, width: Number(match[1]) };
  }
  const ringWidth = (prefix: string): number | null => {
    let width: number | null = null;
    for (const token of classes) {
      if (!token.startsWith(prefix)) continue;
      const rest = token.slice(prefix.length);
      if (rest === "inset-ring") width = 1;
      const match = /^inset-ring-(\d+)$/.exec(rest);
      if (match) width = Number(match[1]);
    }
    return width;
  };
  const width = ringWidth("data-selected:") ?? ringWidth("") ?? 0;
  const colour = lastPaint(classes, "data-selected:", "inset-ring", extra) ?? lastPaint(classes, "", "inset-ring", extra);
  const layers: Band[] = [...(shadow ? [shadow] : []), ...(colour ? [{ paint: colour, width }] : [])];
  const bands: Band[] = [];
  let covered = 0;
  for (const layer of layers) {
    if (layer.width > covered) bands.push({ paint: layer.paint, width: layer.width - covered });
    covered = Math.max(covered, layer.width);
  }
  return bands;
}

/**
 * Selected must read as selected, two ways, measured on the EXPOSED keyline bands:
 *   1. against the PAGE: the outermost exposed band is wider than 0px and contrasts ≥ 3:1 with
 *      `--paper-050`. A paper-only ring touching the chip edge merges into the page, so the chip
 *      only looks smaller — the Deadline's first selected look;
 *   2. against the chip: an exposed band wider than 0px contrasts ≥ 3:1 with the selected fill (the
 *      Deadline's paper band between its ink edge and ink fill), or the selected fill differs from
 *      rest.
 */
function selectionIndistinct(label: string, className: string, view: View, eventColor: string | null): string[] {
  const extra = extraFor(eventColor);
  const classes = className.split(/\s+/).filter(Boolean);
  const backgrounds = effectiveBackgrounds(classes, view, extra);
  const bands = exposedBands(classes, extra);
  const outermost = bands[0] ?? null;
  const page = resolveVar("--paper-050", extra);
  const failures: string[] = [];
  if (!outermost || contrast(over(outermost.paint, page), page) < 3) {
    failures.push(`${label} × ${view}: no exposed selected keyline visible against the page (--paper-050)${outermost ? ` — ${outermost.width}px at ${contrast(over(outermost.paint, page), page).toFixed(2)}:1` : ""}`);
  }
  for (const groundName of GROUNDS) {
    const ground = resolveVar(groundName, extra);
    const rest = backgrounds.rest ? over(backgrounds.rest, ground) : ground;
    const selected = backgrounds.selected ? over(backgrounds.selected, ground) : ground;
    const bandOk = bands.some(({ paint }) => contrast(over(paint, selected), selected) >= 3);
    const fillDiffers = rest.some((c, i) => Math.abs(c - selected[i]!) > 1e-6);
    if (!bandOk && !fillDiffers) failures.push(`${label} × ${view} × ${groundName}: no exposed band marks the selected fill, and it matches rest`);
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------
// Fixture: the real-vendor idiom of ProductionEventCalendar-real.dom.test.tsx.
// ---------------------------------------------------------------------------------------------

const principal = "11111111-1111-4111-8111-111111111111";
const assignee = "22222222-2222-4222-8222-222222222222";
const project = { id: principal, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 3, total: 5 }, delivered: false };
const calendarFor = (subview: DashboardCalendarState["subview"]): DashboardCalendarState => ({
  view: "calendar", date: "2026-08-12", subview, layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: true, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
});
const checklistItem = (id: string, title: string, completed: boolean) => ({
  id, kind: "checklist", title, project,   assignees: [{ id: assignee, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true }], otherAssigneeCount: 0,
  timing: { allDay: true, start: "2026-08-12", end: null }, status: { overdue: false, delivered: false, completed, sameAssigneeOverlap: false },
  schedule: { state: "range", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: startMoment("2026-08-12"), end: endMoment("2026-08-12"), due: "2026-08-12" },
  permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true },
});
const response = adminProductionCalendarRangeResponseSchema.parse({
  range: {
    start: "2026-07-27", end: "2026-09-07", date: "2026-08-12", subview: "month", zone: PRODUCTION_CALENDAR_ZONE,
    appliedFilters: { layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: true, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
  },
  events: [
    { id: "project-deadline:project", kind: "project_deadline", title: "Project handoff", project, timing: { allDay: false, start: "2026-08-12T00:00:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false }, permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-12T10:00", deadlineVersion: 3, reminderOffsetsMinutes: [] },
    checklistItem("checklist:active", "Select hero images", false),
    checklistItem("checklist:done", "Cull the bracket set", true),
  ],
  filterFacets: { projects: [{ id: principal, street: "12 Harbour Street" }], people: [], myTasksUserId: assignee },
});

const CHIPS = [
  { id: "project-deadline:project", label: "Deadline" },
  { id: "checklist:active", label: "active checklist" },
  { id: "checklist:done", label: "done checklist" },
] as const;
const VIEWS: View[] = ["month", "week", "day", "days", "agenda"];

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

async function renderView(view: View) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><ProductionEventCalendar identity={{ principalId: principal, role: "admin", authorizationEpoch: 0 }} calendar={calendarFor(view)} onNavigate={() => undefined} /></QueryClientProvider>);
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

function chipsFor(id: string, view: View): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(`[data-ec-event-id="${id}"]`)].filter((el) => el.getAttribute("data-view") === view);
}

/** Every text measurement for every chip in one view; also fails when a chip or its selection cue is missing. */
async function measureView(view: View): Promise<{ measurements: Measurement[]; indistinct: string[] }> {
  await renderView(view);
  const measurements: Measurement[] = [];
  const indistinct: string[] = [];
  for (const { id, label } of CHIPS) {
    const chips = chipsFor(id, view);
    expect(chips.length, `${label} did not render in ${view}`).toBeGreaterThan(0);
    for (const chip of chips) {
      const eventColor = chip.style.getPropertyValue("--ec-event-color") || null;
      measurements.push(...measure(label, chip, view, eventColor));
      if (view !== "agenda") indistinct.push(...selectionIndistinct(label, chip.className, view, eventColor));
    }
  }
  return { measurements, indistinct };
}

describe("Production chip contrast through the real vendored calendar", () => {
  it.each(VIEWS)("has no chip text under 4.5:1 beyond the recorded baseline, and selected reads as selected — %s", async (view) => {
    const { measurements, indistinct } = await measureView(view);
    const failures = failuresOf(measurements).filter(({ key }) => !(key in CONTRAST_BASELINE)).map(describeFailure);
    expect(failures, failures.join("\n")).toEqual([]);
    expect(indistinct, indistinct.join("\n")).toEqual([]);
  });

  it("keeps the baseline honest — every entry is still a real failure", async () => {
    // If an entry has been fixed, this fails and the entry must be deleted, so the list only shrinks.
    const failing = new Set<string>();
    const views = [...new Set(Object.keys(CONTRAST_BASELINE).map((key) => key.split(" × ")[1] as View))];
    for (const view of views) for (const { key } of failuresOf((await measureView(view)).measurements)) failing.add(key);
    const fixed = Object.keys(CONTRAST_BASELINE).filter((key) => !failing.has(key));
    expect(fixed, `Fixed — delete from CONTRAST_BASELINE: ${fixed.join(", ")}`).toEqual([]);
  });

  it("never baselines a Deadline chip", () => {
    expect(Object.keys(CONTRAST_BASELINE).filter((key) => key.startsWith("Deadline ×"))).toEqual([]);
  });

  it("an agenda Deadline row hides the vendor's colour dot; checklist rows keep theirs", async () => {
    await renderView("agenda");
    // That the variant targets a real vendored element is pinned against the vendored source in
    // lib/production-event-calendar-adapter.test.ts, not by selecting the vendor's slot here (guard F).
    const deadlineRows = chipsFor("project-deadline:project", "agenda");
    expect(deadlineRows.length).toBeGreaterThan(0);
    for (const row of deadlineRows) expect(classesOf(row)).toContain(DEADLINE_AGENDA_DOT);
    for (const id of ["checklist:active", "checklist:done"]) {
      const rows = chipsFor(id, "agenda");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(classesOf(row)).not.toContain(DEADLINE_AGENDA_DOT);
      }
    }
  });

  it("a chip selected in week is not drawn selected once the view switches to the read-only agenda", async () => {
    await renderView("week");
    const [weekChip] = chipsFor("project-deadline:project", "week");
    await act(async () => { weekChip!.click(); await Promise.resolve(); });
    expect(chipsFor("project-deadline:project", "week")[0]!.hasAttribute("data-selected"), "the week click did not select the chip").toBe(true);
    await renderView("agenda");
    const rows = chipsFor("project-deadline:project", "agenda");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.hasAttribute("data-selected"), "an agenda row carries data-selected").toBe(false);
  });

  it("the resolver fails the pre-fix Deadline classes it replaced", () => {
    // Selected, grid: the old consumer class plus the vendor's surviving selected wash.
    const selected = failuresOf(measure(
      "pre-fix Deadline",
      "bg-(--ink-900) hover:bg-(--ink-800) text-(--paper-050) inset-ring-(--ink-900) data-selected:bg-(--ec-event-color)/30",
      "week",
      "var(--ink-900)",
    ));
    expect(selected.some(({ tuple }) => tuple.includes("× selected ×")), selected.map(describeFailure).join("\n")).toBe(true);
    // Hover, agenda: the old merged row class, whose `hover:bg-(--ink-800)` lost to the row's `hover:bg-muted`.
    const agenda = failuresOf(measure("pre-fix Deadline", "bg-(--ink-900) text-(--paper-050) inset-ring-(--ink-900) hover:bg-muted", "agenda", "var(--ink-900)"));
    expect(agenda.some(({ tuple }) => tuple.includes("× hover ×")), agenda.map(describeFailure).join("\n")).toBe(true);
  });

  it("the distinctness check fails a selected state that only repeats rest", () => {
    expect(selectionIndistinct("fake", "bg-(--ink-900) text-(--paper-050) data-selected:bg-(--ink-900)", "week", null)).not.toEqual([]);
  });

  it("the keyline check measures exposed bands: it fails a 0px ink edge, an ink edge that hides the paper band, and the old paper-only ring", () => {
    const fill = "bg-(--ink-900) text-(--paper-050) inset-ring inset-ring-(--ink-900) data-selected:bg-(--ink-900)";
    const paperRing = "data-selected:inset-ring-4 data-selected:inset-ring-(--paper-050)";
    const cases = {
      "0px ink edge": `${fill} ${paperRing} data-selected:inset-shadow-[0_0_0_0px_var(--ink-900)]`,
      "ink edge as wide as the paper ring": `${fill} ${paperRing} data-selected:inset-shadow-[0_0_0_4px_var(--ink-900)]`,
      "old paper-only 2px ring": `${fill} data-selected:inset-ring-2 data-selected:inset-ring-(--paper-050)`,
    };
    for (const [name, className] of Object.entries(cases)) {
      expect(selectionIndistinct(name, className, "week", null), `${name} should fail the keyline check`).not.toEqual([]);
    }
    expect(selectionIndistinct("Deadline", `${fill} ${paperRing} data-selected:inset-shadow-[0_0_0_2px_var(--ink-900)]`, "week", null)).toEqual([]);
    // The ink edge hides nothing it should not: 2px ink, then 2px paper, then the fill.
    const bands = exposedBands(`${fill} ${paperRing} data-selected:inset-shadow-[0_0_0_2px_var(--ink-900)]`.split(" "), new Map());
    expect(bands.map(({ width }) => width)).toEqual([2, 2]);
  });

});
