import {
  adminProductionCalendarRangeResponseSchema,
  deriveProductionCalendarWindow,
  editorProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  productionCalendarFiltersSchema,
  type DashboardCalendarState,
  type DashboardCalendarRoute,
  type ProductionCalendarFilters,
  type ProductionCalendarRangeResponse,
  type Role,
} from "@quincy/shared";
import { useQuery, type QueryClient, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { externalApiGet } from "./external-api-response";
import { projectQueryRetry } from "./project-data";
import { staffPathFor } from "./router";
import type { DashboardIdentity } from "./dashboard-projects";
import { normalizeDashboardCalendarSearch } from "../screens/dashboard-helpers";

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
  const normalizedSearch = filters.search;
  assertCanonicalFilters(calendar, filters);

  const route = staffPathFor({ kind: "dashboard", calendar } satisfies DashboardCalendarRoute);
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
