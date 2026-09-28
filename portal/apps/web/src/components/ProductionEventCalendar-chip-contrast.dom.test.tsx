/**
 * Every Production chip stays readable in every state it can be drawn in — rest, hover, selected,
 * selected + hover — in week, month and agenda, through the REAL vendored event calendar.
 *
 * WHY. The chip's class is `cn(vendor tint, eventClassName)`, and tailwind-merge drops a vendor
 * utility only when the consumer supplies the SAME variant. A state the consumer forgets keeps the
 * vendor's `--ec-event-color` wash under the consumer's text colour. That shipped twice: a selected
 * Deadline drew ink-900/30 under paper text (2.03:1), and a hovered agenda Deadline row took the
 * agenda row's `hover:bg-muted` — paper on paper (1.07:1). Each class string looked right on its
 * own; only the MERGED class shows the defect, so this reads the real merged `className` off the
 * rendered chip and resolves it against the live token files.
 *
 * happy-dom computes no real colour, so the resolver models the cascade from the class list (the
 * rules are spelled out in `effectiveBackgrounds`) and composites alpha in sRGB — an approximation
 * of Tailwind v4's `color-mix(in oklab)`, but every margin here is far from the 4.5:1 threshold.
 * The self-tests at the bottom feed it the pre-fix classes and require it to fail them.
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

/** `bg-(--x)/NN`, `bg-muted`, `text-foreground-secondary`… → a colour, or null for a non-colour utility (`text-sm`). */
function paintOf(utility: string, kind: "bg" | "text", extra: Map<string, string>): Paint | null {
  const match = new RegExp(`^${kind}-(.+?)(?:/(\\d+))?$`).exec(utility);
  if (!match) return null;
  const alpha = match[2] ? Number(match[2]) / 100 : 1;
  const arbitrary = /^\((--[\w-]+)\)$/.exec(match[1]!);
  const name = arbitrary ? arbitrary[1]! : `--color-${match[1]}`;
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
type View = "week" | "month" | "agenda";

/** The last utility with exactly this variant prefix that resolves to a colour. */
function lastPaint(classes: string[], prefix: string, kind: "bg" | "text", extra: Map<string, string>): Paint | null {
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

/** Every (state × ground) whose text contrast is under 4.5:1, as readable tuples. */
function contrastFailures(label: string, className: string, view: View, eventColor: string | null): string[] {
  const extra = new Map<string, string>(eventColor ? [["--ec-event-color", eventColor]] : []);
  const classes = className.split(/\s+/).filter(Boolean);
  const text = lastPaint(classes, "", "text", extra);
  if (!text) return [`${label} × ${view}: no text colour utility survives the merge`];
  const backgrounds = effectiveBackgrounds(classes, view, extra);
  const failures: string[] = [];
  for (const state of STATES) {
    for (const groundName of GROUNDS) {
      const ground = resolveVar(groundName, extra);
      const paint = backgrounds[state];
      const fill = paint ? over(paint, ground) : ground;
      const ratio = contrast(over(text, fill), fill);
      if (ratio < 4.5) failures.push(`${label} × ${view} × ${state} × ${groundName}: ${ratio.toFixed(2)}:1`);
    }
  }
  return failures;
}

/** Selected must read as selected: a ring that contrasts ≥ 3:1 with the selected fill, or a different fill. */
function selectionIndistinct(label: string, className: string, view: View, eventColor: string | null): string[] {
  const extra = new Map<string, string>(eventColor ? [["--ec-event-color", eventColor]] : []);
  const classes = className.split(/\s+/).filter(Boolean);
  const backgrounds = effectiveBackgrounds(classes, view, extra);
  let ring: Paint | null = null;
  for (const token of classes) {
    const match = /^data-selected:inset-ring-\((--[\w-]+)\)(?:\/(\d+))?$/.exec(token);
    if (match) ring = { rgb: resolveVar(match[1]!, extra), alpha: match[2] ? Number(match[2]) / 100 : 1 };
  }
  const failures: string[] = [];
  for (const groundName of GROUNDS) {
    const ground = resolveVar(groundName, extra);
    const rest = backgrounds.rest ? over(backgrounds.rest, ground) : ground;
    const selected = backgrounds.selected ? over(backgrounds.selected, ground) : ground;
    const ringOk = ring !== null && contrast(over(ring, selected), selected) >= 3;
    const fillDiffers = rest.some((c, i) => Math.abs(c - selected[i]!) > 1e-6);
    if (!ringOk && !fillDiffers) failures.push(`${label} × ${view} × ${groundName}: selected looks exactly like rest`);
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
  id, kind: "checklist", title, project, assignee: { id: assignee, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true },
  timing: { allDay: true, start: "2026-08-13", end: null }, status: { overdue: false, delivered: false, completed, sameAssigneeOverlap: false },
  schedule: { state: "due_only", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: { kind: "date", localCivil: "2026-08-13", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, due: "2026-08-13" },
  permissions: { canDrag: true, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true },
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
  unscheduled: [],
  filterFacets: { projects: [{ id: principal, street: "12 Harbour Street" }], people: [], myTasksUserId: assignee, unscheduled: { project: { matched: 0, returned: 0, truncated: false }, checklist: { matched: 0, returned: 0, truncated: false } } },
});

const CHIPS = [
  { id: "project-deadline:project", label: "Deadline" },
  { id: "checklist:active", label: "active checklist" },
] as const;
const VIEWS: View[] = ["week", "month", "agenda"];

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

describe("Production chip contrast through the real vendored calendar", () => {
  it.each(VIEWS)("every chip clears 4.5:1 in every state over every paper ground — %s", async (view) => {
    await renderView(view);
    const failures: string[] = [];
    for (const { id, label } of CHIPS) {
      const chips = chipsFor(id, view);
      expect(chips.length, `${label} did not render in ${view}`).toBeGreaterThan(0);
      for (const chip of chips) {
        failures.push(...contrastFailures(label, chip.className, view, chip.style.getPropertyValue("--ec-event-color") || null));
        if (view !== "agenda") failures.push(...selectionIndistinct(label, chip.className, view, chip.style.getPropertyValue("--ec-event-color") || null));
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("the resolver fails the pre-fix Deadline classes it replaced", () => {
    // Selected, grid: the old consumer class plus the vendor's surviving selected wash.
    const selected = contrastFailures(
      "pre-fix Deadline",
      "bg-(--ink-900) hover:bg-(--ink-800) text-(--paper-050) inset-ring-(--ink-900) data-selected:bg-(--ec-event-color)/30",
      "week",
      "var(--ink-900)",
    );
    expect(selected.some((failure) => failure.includes("× selected ×")), selected.join("\n")).toBe(true);
    expect(selected.every((failure) => Number(failure.split(": ").pop()!.replace(":1", "")) < 4.5)).toBe(true);
    // Hover, agenda: the old merged row class, whose `hover:bg-(--ink-800)` lost to the row's `hover:bg-muted`.
    const agenda = contrastFailures("pre-fix Deadline", "bg-(--ink-900) text-(--paper-050) inset-ring-(--ink-900) hover:bg-muted", "agenda", "var(--ink-900)");
    expect(agenda.some((failure) => failure.includes("× hover ×")), agenda.join("\n")).toBe(true);
  });

  it("the distinctness check fails a selected state that only repeats rest", () => {
    expect(selectionIndistinct("fake", "bg-(--ink-900) text-(--paper-050) data-selected:bg-(--ink-900)", "week", null)).not.toEqual([]);
  });
});
