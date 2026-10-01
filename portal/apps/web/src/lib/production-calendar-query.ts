import {
  adminProductionCalendarRangeResponseSchema,
  CHECKLIST_SCHEDULE_ZONE,
  deriveProductionCalendarWindow,
  editorProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  externalChecklistItemSchema,
  productionCalendarFiltersSchema,
  stripUnsafeText,
  type CalendarPerson,
  type ChecklistScheduleDto,
  type DashboardCalendarState,
  type DashboardCalendarFacetRoute,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  type Role,
} from "@quincy/shared";
import { z } from "zod";
import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { externalApiGet } from "./external-api-response";
import { projectQueryRetry } from "./project-data";
import { staffPathFor } from "./router";
import type { DashboardIdentity } from "./dashboard-projects";
import { normalizeDashboardCalendarSearch } from "../screens/dashboard-helpers";
import type { ChecklistMutationResult } from "./scheduling-types";

const DEFAULT_WINDOW = { start: "1970-01-01", end: "1970-01-02" } as const;
const DEFAULT_FILTERS = productionCalendarFiltersSchema.parse({});

export function productionCalendarFiltersFor(calendar: DashboardCalendarState): ProductionCalendarFilters {
  return {
    layers: calendar.layers,
    editorIds: calendar.editorIds,
    includeUnassigned: calendar.includeUnassigned,
    stageKeys: calendar.stageKeys,
    priorities: calendar.priorities,
    archived: calendar.archived,
    shootRange: calendar.shootRange,
    deadlineRange: calendar.deadlineRange,
    showCompletedChecklist: calendar.showCompletedChecklist,
    showDeliveredProjects: calendar.showDeliveredProjects,
    overdueOnly: calendar.overdueOnly,
    search: normalizeDashboardCalendarSearch(calendar.search),
    myTasks: calendar.myTasks,
  };
}

function assertCanonicalFilters(calendar: DashboardCalendarState, filters: ProductionCalendarFilters): void {
  const normalized = productionCalendarFiltersSchema.parse({ ...filters, search: filters.search.trim().replace(/\s+/gu, " ") });
  if (JSON.stringify({ ...normalized, search: filters.search }) !== JSON.stringify(filters)) {
    throw new RangeError("Production Calendar filters must be canonical before they are queried.");
  }
  if (calendar.editorIds.some((value) => value !== value.toLowerCase()) || calendar.stageKeys.some((value, index) => filters.stageKeys[index] !== value)) {
    throw new RangeError("Production Calendar filters must use canonical ordering and casing.");
  }
}

/**
 * Build the API query from the exact route serializer, retaining its fixed
 * field order while adding the server-only bounded window and active scope.
 */
export function buildProductionCalendarQuery(
  calendar: DashboardCalendarState,
  window = deriveProductionCalendarWindow(calendar.date, calendar.subview),
  // #222: `bounds=1` asks for `projectBounds` (the event-calendar renderer). Off by default — the
  // retired FullCalendar build never sent it, so its strict decoders never saw the key.
  { bounds = false }: { bounds?: boolean } = {},
): string {
  const filters = productionCalendarFiltersFor(calendar);
  // Mirror calendarPathFor's serialization-side guard: the server's unsafeText
  // check rejects a backslash / C0 char with 400, so strip on the API path too
  // rather than trusting the caller (same fixed-point rationale as 806c499).
  const normalizedSearch = stripUnsafeText(filters.search);
  assertCanonicalFilters(calendar, filters);

  const route = staffPathFor({ kind: "dashboard", calendar } satisfies DashboardCalendarFacetRoute);
  const question = route.indexOf("?");
  if (question < 0) throw new RangeError("Calendar route did not contain its query contract.");
  const params = new URLSearchParams(route.slice(question + 1));
  if (params.get("view") !== "calendar") throw new RangeError("Calendar route did not contain the Calendar view marker.");
  params.delete("view");
  if (normalizedSearch) params.set("q", normalizedSearch); else params.delete("q");
  params.set("start", window.start);
  params.set("end", window.end);
  params.set("scope", "active");
  if (bounds) params.set("bounds", "1");
  return params.toString();
}

function responseSchemaFor(role: Role): { parse: (value: unknown) => ProductionCalendarRangeResponse } {
  if (role === "admin") return adminProductionCalendarRangeResponseSchema;
  if (role === "editor") return editorProductionCalendarRangeResponseSchema;
  if (role === "external_editor") return externalCalendarRangeSchema;
  throw new RangeError("Photographers do not have a Production Calendar response domain.");
}

const mutationEndpointSchema = z.object({
  kind: z.enum(["date", "timed"]),
  localCivil: z.string(),
  instant: z.string().nullable(),
  utcOffsetMinutes: z.number().int().nullable(),
  fold: z.union([z.literal(0), z.literal(1)]).nullable(),
  resolution: z.literal("stored"),
}).strict();

const mutationScheduleSchema: z.ZodType<ChecklistScheduleDto> = z.object({
  state: z.literal("range"),
  version: z.number().int().min(1),
  zone: z.literal(CHECKLIST_SCHEDULE_ZONE),
  start: mutationEndpointSchema,
  end: mutationEndpointSchema,
  due: z.string(),
}).strict();

// The internal Worker DTO has no compile-time link to @quincy/shared. This
// decoder intentionally accepts additive top-level Worker fields so an
// unrelated server addition cannot break Calendar reconciliation.
const internalChecklistMutationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  done: z.boolean(),
  assignees: z.array(z.object({ id: z.string().min(1), name: z.string() }).passthrough()).optional(),
  assignmentVersion: z.number().int().nonnegative().optional(),
  position: z.number().int(),
  schedule: mutationScheduleSchema,
}).passthrough();

type InternalPerson = { id: string; name: string; roleLabel?: unknown; isExternal?: unknown; active?: unknown };

function internalPerson(person: InternalPerson): CalendarPerson {
  // The decoder accepts additive Worker fields, so a person's optional keys get the same defaults as before.
  return {
    id: person.id,
    name: person.name,
    roleLabel: typeof person.roleLabel === "string" ? person.roleLabel : "Assignee",
    isExternal: typeof person.isExternal === "boolean" ? person.isExternal : false,
    active: typeof person.active === "boolean" ? person.active : true,
  };
}

/** Select one mutation response domain from the captured principal. */
export function decodeChecklistMutationResponse(role: Role, value: unknown): ChecklistMutationResult {
  if (role === "external_editor") {
    const parsed = externalChecklistItemSchema.parse(value);
    return {
      id: parsed.id,
      title: parsed.title,
      done: parsed.done,
      // The server's team-filtered list and hidden count (#368).
      assignees: parsed.assignees,
      otherAssigneeCount: parsed.otherAssigneeCount,
      assignmentVersion: parsed.assignmentVersion,
      position: parsed.position,
      schedule: parsed.schedule,
      scheduleVersion: parsed.schedule.version,
    };
  }
  if (role === "admin" || role === "editor") {
    const parsed = internalChecklistMutationSchema.parse(value);
    return {
      id: parsed.id,
      title: parsed.title,
      done: parsed.done,
      assignees: parsed.assignees ? parsed.assignees.map((person) => internalPerson(person)) : null,
      ...(parsed.assignmentVersion === undefined ? {} : { assignmentVersion: parsed.assignmentVersion }),
      position: parsed.position,
      schedule: parsed.schedule,
      scheduleVersion: parsed.schedule.version,
    };
  }
  throw new RangeError("Photographers do not have a checklist mutation response domain.");
}

/** Select exactly one authenticated role-domain decoder, with no permissive fallback. */
export function decodeProductionCalendarResponse(role: Role, value: unknown): ProductionCalendarRangeResponse {
  return responseSchemaFor(role).parse(value);
}

export function productionCalendarKey(
  identity: DashboardIdentity,
  scope: "active",
  window: { start: string; end: string },
  subview: DashboardCalendarState["subview"],
  filters: ProductionCalendarFilters,
  { bounds = false }: { bounds?: boolean } = {},
) {
  const key = ["production-calendar", identity.principalId, identity.role, identity.authorizationEpoch, scope, window.start, window.end, subview, filters] as const;
  // #222: a bounds response carries a field the plain one lacks — never share a cache entry.
  return bounds ? [...key, { bounds: true }] as const : key;
}

export function removeProductionCalendarQueries(client: QueryClient, principalId: string): void {
  const queryKey = ["production-calendar", principalId] as const;
  void client.cancelQueries({ queryKey });
  client.removeQueries({ queryKey });
}

export type ProductionCalendarRangeQueryOptionsInput = {
  identity: DashboardIdentity;
  calendar: DashboardCalendarState | null;
  enabled: boolean;
  /** #222: request `projectBounds` (`bounds=1`). Off by default; the old calendar never sets it. */
  bounds?: boolean;
};

export function productionCalendarRangeQueryOptions({ identity, calendar, enabled, bounds = false }: ProductionCalendarRangeQueryOptionsInput) {
  const window = calendar ? deriveProductionCalendarWindow(calendar.date, calendar.subview) : DEFAULT_WINDOW;
  const filters = calendar ? productionCalendarFiltersFor(calendar) : DEFAULT_FILTERS;
  const subview = calendar?.subview ?? "month";
  return {
    queryKey: productionCalendarKey(identity, "active", window, subview, filters, { bounds }),
    enabled: enabled && calendar !== null,
    queryFn: async ({ signal }: QueryFunctionContext) => {
      if (calendar === null) throw new Error("A Calendar route is required before fetching production Calendar data.");
      const path = `/api/production-calendar?${buildProductionCalendarQuery(calendar, window, { bounds })}`;
      const response = identity.role === "external_editor"
        ? await externalApiGet("calendar", path, signal)
        : await apiGet<unknown>(path, { signal });
      return decodeProductionCalendarResponse(identity.role, response);
    },
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: projectQueryRetry,
  };
}

export function useProductionCalendarRange(input: ProductionCalendarRangeQueryOptionsInput): UseQueryResult<ProductionCalendarRangeResponse, Error> {
  return useQuery<ProductionCalendarRangeResponse, Error>(productionCalendarRangeQueryOptions(input));
}
