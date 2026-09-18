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
export function buildProductionCalendarQuery(calendar: DashboardCalendarState, window = deriveProductionCalendarWindow(calendar.date, calendar.subview)): string {
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
  return params.toString();
}

function responseSchemaFor(role: Role): { parse: (value: unknown) => ProductionCalendarRangeResponse } {
  if (role === "admin") return adminProductionCalendarRangeResponseSchema;
  if (role === "editor") return editorProductionCalendarRangeResponseSchema;
  if (role === "external_editor") return externalCalendarRangeSchema;
  throw new RangeError("Photographers do not have a Production Calendar response domain.");
}

// §216 fix round 2 item 4: single definition lives in scheduling-types.ts (a neutral module, so
// scheduling-policy.ts/scheduling-undo.ts import no query-layer file for this type); re-exported
// here so this module's own (query-layer) importers are untouched.
export type { ChecklistMutationResult } from "./scheduling-types";

const mutationEndpointSchema = z.object({
  kind: z.enum(["date", "timed"]),
  localCivil: z.string(),
  instant: z.string().nullable(),
  utcOffsetMinutes: z.number().int().nullable(),
  fold: z.union([z.literal(0), z.literal(1)]).nullable(),
  resolution: z.enum(["stored", "derived_unambiguous"]),
}).strict();

const mutationScheduleSchema: z.ZodType<ChecklistScheduleDto> = z.union([
  z.object({
    state: z.literal("unscheduled"),
    version: z.number().int().nonnegative(),
    zone: z.literal(CHECKLIST_SCHEDULE_ZONE),
    start: z.null(),
    end: z.null(),
    due: z.null(),
  }).strict(),
  z.object({
    state: z.literal("due_only"),
    version: z.number().int().nonnegative(),
    zone: z.literal(CHECKLIST_SCHEDULE_ZONE),
    start: z.null(),
    end: mutationEndpointSchema,
    due: z.string(),
  }).strict(),
  z.object({
    state: z.literal("range"),
    version: z.number().int().nonnegative(),
    zone: z.literal(CHECKLIST_SCHEDULE_ZONE),
    start: mutationEndpointSchema,
    end: mutationEndpointSchema,
    due: z.string().nullable(),
  }).strict(),
  z.object({
    state: z.literal("legacy_unresolved"),
    version: z.literal(0),
    zone: z.literal(CHECKLIST_SCHEDULE_ZONE),
    start: z.null(),
    end: z.null(),
    due: z.string(),
    error: z.object({
      code: z.literal("subtask_schedule_legacy_unresolved"),
      reason: z.enum(["invalid_literal", "nonexistent_local_time", "repeated_local_time"]),
      foldChoices: z.array(z.object({ disambiguation: z.enum(["earlier", "later"]), utcOffsetMinutes: z.number().int() }).passthrough()).optional(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    state: z.literal("invalid"),
    version: z.number().int().nonnegative(),
    zone: z.null(),
    start: z.null(),
    end: z.null(),
    due: z.string().nullable(),
    error: z.object({
      code: z.literal("subtask_schedule_storage_invalid"),
      reason: z.enum(["shape_mismatch", "resolution_mismatch", "ordering_invalid"]),
    }).passthrough(),
  }).passthrough(),
]) as z.ZodType<ChecklistScheduleDto>;

// The internal Worker DTO has no compile-time link to @quincy/shared. This
// decoder intentionally accepts additive top-level Worker fields so an
// unrelated server addition cannot break Calendar reconciliation.
const internalChecklistMutationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  done: z.boolean(),
  assignee: z.object({ id: z.string().min(1), name: z.string() }).passthrough().nullable(),
  position: z.number().int(),
  schedule: mutationScheduleSchema,
}).passthrough();

function internalAssignee(person: { id: string; name: string } | null): CalendarPerson | null {
  return person ? { id: person.id, name: person.name, roleLabel: "Assignee", isExternal: false, active: true } : null;
}

/** Select one mutation response domain from the captured principal. */
export function decodeChecklistMutationResponse(role: Role, value: unknown): ChecklistMutationResult {
  if (role === "external_editor") {
    const parsed = externalChecklistItemSchema.parse(value);
    return {
      id: parsed.id,
      title: parsed.title,
      done: parsed.done,
      assignee: parsed.assignee,
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
      assignee: internalAssignee(parsed.assignee),
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
) {
  return ["production-calendar", identity.principalId, identity.role, identity.authorizationEpoch, scope, window.start, window.end, subview, filters] as const;
}

export function removeProductionCalendarQueries(client: QueryClient, principalId: string): void {
  const queryKey = ["production-calendar", principalId] as const;
  void client.cancelQueries({ queryKey });
  client.removeQueries({ queryKey });
}

export type ProductionCalendarRangeQueryOptionsInput = { identity: DashboardIdentity; calendar: DashboardCalendarState | null; enabled: boolean };

export function productionCalendarRangeQueryOptions({ identity, calendar, enabled }: ProductionCalendarRangeQueryOptionsInput) {
  const window = calendar ? deriveProductionCalendarWindow(calendar.date, calendar.subview) : DEFAULT_WINDOW;
  const filters = calendar ? productionCalendarFiltersFor(calendar) : DEFAULT_FILTERS;
  const subview = calendar?.subview ?? "month";
  return {
    queryKey: productionCalendarKey(identity, "active", window, subview, filters),
    enabled: enabled && calendar !== null,
    queryFn: async ({ signal }: QueryFunctionContext) => {
      if (calendar === null) throw new Error("A Calendar route is required before fetching production Calendar data.");
      const path = `/api/production-calendar?${buildProductionCalendarQuery(calendar, window)}`;
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
