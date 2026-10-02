/**
 * #222 round 3 — the shared mount/fetch/DOM helpers for the `ProductionEventCalendar-*` DOM
 * suites (checklist, deadline, reconciliation, unmount, phone). Test-only.
 *
 * Each suite still declares its own `vi.mock`s (they are hoisted per file) — the vendor tree via
 * `testing/event-calendar-fake.tsx`, and `../lib/auth`. This file only mounts the surface and
 * routes `fetch`:
 *
 * - GET `/api/production-calendar?…bounds=1…` is the surface's MAIN range query; the Up next rail
 *   query never sends `bounds`, so `rangeGets()` counts only the main one (the old suites' `getCount`)
 *   and `upNextGets()` only the rail's (#295).
 * - PATCH (checklist) and PUT (Deadline) are recorded with their parsed bodies.
 *
 * Guard F: helpers select Quincy `data-testid` / `data-focus-key` / `aria-label` hooks only.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import type { DashboardCalendarState, ProductionCalendarRangeResponse } from "@quincy/shared";
import type { CalendarSettleState } from "../lib/production-calendar-interaction";
import { ProjectQueryRuntimeProvider, type ProjectQueryRuntime } from "../lib/project-query-sync";
import { ProductionEventCalendar } from "../components/ProductionEventCalendar";
import { PROJECT_ID } from "./production-calendar-fixtures";
import { eventCalendarFake } from "./event-calendar-fake";

export function calendarState(subview: DashboardCalendarState["subview"] = "month", date = "2026-08-12", layers: DashboardCalendarState["layers"] = ["project", "checklist"]): DashboardCalendarState {
  return { view: "calendar", date, subview, layers, editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide", shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type RecordedCall = { method: string; url: string; body: unknown };
type Handler = (url: string, body: unknown) => Response | Promise<Response>;

export type CalendarFetch = {
  calls: RecordedCall[];
  /** GETs of the main (bounds=1) range. */
  rangeGets: () => RecordedCall[];
  /** GETs of the Up next rail's range (agenda, no bounds) — #295. */
  upNextGets: () => RecordedCall[];
  patches: () => RecordedCall[];
  puts: () => RecordedCall[];
};

/**
 * Stubs `fetch`. `range` answers every calendar GET (main and Up next); `patch` / `put` answer the
 * writes. A handler may return a pending promise to hold a request open.
 */
export function stubCalendarFetch(handlers: { range: Handler | ProductionCalendarRangeResponse; patch?: Handler; put?: Handler }): CalendarFetch {
  const calls: RecordedCall[] = [];
  const range: Handler = typeof handlers.range === "function" ? handlers.range : ((body) => () => json(body))(handlers.range);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (method === "PATCH") return handlers.patch ? handlers.patch(url, body) : json({ message: "unexpected PATCH" }, 500);
    if (method === "PUT") return handlers.put ? handlers.put(url, body) : json({ message: "unexpected PUT" }, 500);
    return range(url, body);
  }));
  return {
    calls,
    rangeGets: () => calls.filter((call) => call.method === "GET" && call.url.includes("bounds=1")),
    upNextGets: () => calls.filter((call) => call.method === "GET" && call.url.includes("sub=agenda") && !call.url.includes("bounds=1")),
    patches: () => calls.filter((call) => call.method === "PATCH"),
    puts: () => calls.filter((call) => call.method === "PUT"),
  };
}

export type SurfaceProps = {
  role?: "admin" | "editor" | "external_editor";
  /** The identity's `authorizationEpoch` (default 0) — a change resets the controller (#291). */
  authorizationEpoch?: number;
  onNavigate?: (next: DashboardCalendarState) => void;
  onAcceptGateChange?: (blocked: boolean) => void;
  onSettleStateChange?: (state: CalendarSettleState) => void;
  onAccessLoss?: () => void;
  projectHrefFor?: (projectId: string) => string | undefined;
  onOpenProject?: (projectId: string) => void;
  onShownProjectsChange?: (count: number | null) => void;
  /** Wraps the surface in a `ProjectQueryRuntimeProvider` (cross-tab invalidation tests). */
  runtime?: ProjectQueryRuntime;
};

export type Harness = {
  host: HTMLDivElement;
  client: QueryClient;
  render: (calendar: DashboardCalendarState, props?: SurfaceProps) => Promise<void>;
  rerender: (calendar: DashboardCalendarState, props?: SurfaceProps) => Promise<void>;
  unmount: () => Promise<void>;
  teardown: () => void;
};

/**
 * Stubs `window.matchMedia` so exactly the listed queries match. `createHarness()` applies `[]`
 * (a wide desktop, fine pointer: the rail sits beside the grid); the phone suite passes
 * `["(max-width: 720px)", "(pointer: coarse)", "(max-width: 1100px)"]`.
 */
export function stubMedia(matching: string[]): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({ matches: matching.includes(query), media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })),
  });
}

export function createHarness(): Harness {
  stubMedia([]);
  const host = document.createElement("div");
  document.body.append(host);
  let root: Root | null = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  eventCalendarFake.reset();
  let mounted = false;

  const element = (calendar: DashboardCalendarState, props: SurfaceProps = {}) => {
    const page = (
    <QueryClientProvider client={client}>
      <ProductionEventCalendar
        identity={{ principalId: PROJECT_ID, role: props.role ?? "admin", authorizationEpoch: props.authorizationEpoch ?? 0 }}
        calendar={calendar}
        onNavigate={props.onNavigate ?? (() => undefined)}
        onAcceptGateChange={props.onAcceptGateChange}
        onSettleStateChange={props.onSettleStateChange}
        onAccessLoss={props.onAccessLoss}
        projectHrefFor={props.projectHrefFor}
        onOpenProject={props.onOpenProject}
        onShownProjectsChange={props.onShownProjectsChange}
      />
    </QueryClientProvider>
    );
    return props.runtime ? <ProjectQueryRuntimeProvider runtime={props.runtime}>{page}</ProjectQueryRuntimeProvider> : page;
  };

  return {
    host,
    client,
    async render(calendar, props) {
      if (!mounted) { root = createRoot(host); mounted = true; }
      const live = root!;
      await act(async () => { live.render(element(calendar, props)); await Promise.resolve(); });
      await flush(10);
      await flush(0);
    },
    async rerender(calendar, props) {
      await act(async () => { root!.render(element(calendar, props)); await Promise.resolve(); });
    },
    async unmount() {
      if (!mounted) return;
      mounted = false;
      const live = root!; root = null;
      await act(async () => { live.unmount(); await Promise.resolve(); });
    },
    teardown() {
      if (mounted && root) { const live = root; act(() => live.unmount()); }
      root = null;
      mounted = false;
      host.remove();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
    },
  };
}

export async function flush(ms = 0): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); await Promise.resolve(); await Promise.resolve(); });
}

export async function clickTestId(testId: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`no [data-testid="${testId}"]`);
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
}

export async function clickFocusKey(key: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
  if (!element) throw new Error(`no [data-focus-key="${key}"]`);
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
}

/**
 * Opens an event's item menu (a chip click through the fake vendor) and picks its Deadline action
 * ("Reschedule…") or checklist action ("Edit schedule…"), then lets the menu finish closing: the
 * action runs from the menu's close, after the item has been focused (#463).
 */
export async function openReschedule(eventId: string): Promise<void> {
  await act(async () => { eventCalendarFake.click(eventId); await Promise.resolve(); await Promise.resolve(); });
  await flush(30);
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === "Reschedule…" || node.textContent === "Edit schedule…");
  if (!item) throw new Error(`no Reschedule… / Edit schedule… row for ${eventId}`);
  await act(async () => { item.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(60);
}

/** Opens an event's item menu and returns its "Reschedule…" / "Edit schedule…" row (null when absent), then leaves the menu open. */
export async function openItemMenuRow(eventId: string): Promise<HTMLElement | null> {
  await act(async () => { eventCalendarFake.click(eventId); await Promise.resolve(); await Promise.resolve(); });
  await flush(30);
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === "Reschedule…" || node.textContent === "Edit schedule…") ?? null;
}

/** Closes an open item menu with Escape and lets it finish unmounting. */
export async function closeItemMenu(): Promise<void> {
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
  await flush(30);
}

export async function setValue(element: HTMLInputElement | HTMLSelectElement | null, value: string): Promise<void> {
  if (!element) throw new Error("setValue: element is missing");
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

export function byLabel<T extends HTMLElement = HTMLInputElement>(label: string): T | null {
  return document.querySelector<T>(`[aria-label="${label}"]`);
}

export function liveRegion(): string {
  return document.querySelector('[data-testid="dashboard-live-region"]')?.textContent ?? "";
}

/** Fires the fake vendor's `onEventUpdate` inside `act`, returning the surface's result. */
export async function proposeUpdate(eventId: string, input: Parameters<typeof eventCalendarFake.update>[1]): Promise<unknown> {
  let result: unknown;
  await act(async () => { result = eventCalendarFake.update(eventId, input); await Promise.resolve(); await Promise.resolve(); });
  return result;
}

/** The chip's displayed start (ISO), from the fake's rendered event list. */
/** The Up next rail's items, as rendered text (title, then "Wed 12 Aug · 09:00 · detail"). */
export function upNextItems(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="event-calendar-up-next-item"]')].map((item) => item.textContent ?? "");
}

export function chipStart(eventId: string): string | undefined {
  return eventCalendarFake.event(eventId)?.start.toISOString();
}

/** The main range query (the bounds=1 one), for `setQueryData` in reconciliation tests. */
export function mainRangeQuery(client: QueryClient) {
  const queries = client.getQueryCache().findAll({ queryKey: ["production-calendar", PROJECT_ID] });
  // The Up next query is always an agenda window starting today; the main one carries `bounds`.
  const main = queries.find((query) => JSON.stringify(query.queryKey).includes("bounds")) ?? queries[0];
  if (!main) throw new Error("Calendar query was not created");
  return main;
}
