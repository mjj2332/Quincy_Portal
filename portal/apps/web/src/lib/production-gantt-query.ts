import {
  adminProductionGanttResponseSchema,
  editorProductionGanttResponseSchema,
  externalProductionGanttSchema,
  productionGanttChildPageSchema,
  type GanttChecklistRowDto,
  type GanttProjectRowDto,
  type ProductionGanttChildPageResponse,
  type ProductionGanttResponse,
  type Role,
  type StagePresentationKey,
} from "@quincy/shared";
import { useInfiniteQuery, type InfiniteData, type QueryClient, type QueryFunctionContext, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { apiGet } from "./api";
import { externalApiGet } from "./external-api-response";
import { projectQueryRetry } from "./project-data";
import type { DashboardIdentity } from "./dashboard-projects";

export type ProductionGanttFilters = {
  q: string;
  editorIds: string[];
  stageKeys: StagePresentationKey[];
  delivered: boolean;
  completed: boolean;
  limit?: number;
};

const DEFAULT_FILTERS: ProductionGanttFilters = { q: "", editorIds: [], stageKeys: [], delivered: false, completed: false };

function buildGanttPageQuery(filters: ProductionGanttFilters, cursor: string | undefined): string {
  const params = new URLSearchParams();
  params.set("scope", "active");
  if (filters.q) params.set("q", filters.q);
  if (filters.editorIds.length > 0) params.set("editors", filters.editorIds.join(","));
  if (filters.stageKeys.length > 0) params.set("stages", filters.stageKeys.join(","));
  if (filters.delivered) params.set("delivered", "1");
  if (filters.completed) params.set("completed", "1");
  if (filters.limit) params.set("limit", String(filters.limit));
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

/** Select exactly one authenticated role-domain decoder, with no permissive fallback — mirrors
 * `decodeProductionCalendarResponse` in `production-calendar-query.ts`. */
export function decodeProductionGanttResponse(role: Role, value: unknown): ProductionGanttResponse {
  if (role === "admin") return adminProductionGanttResponseSchema.parse(value);
  if (role === "editor") return editorProductionGanttResponseSchema.parse(value);
  if (role === "external_editor") return externalProductionGanttSchema.parse(value) as ProductionGanttResponse;
  throw new RangeError("Photographers do not have a Production Gantt response domain.");
}

/**
 * The `"production-gantt"` prefix and the principal at index 1 are load-bearing: cross-tab
 * invalidation matches on `queryKey[0] === "production-gantt"`
 * (`lib/project-query-sync.ts`), and `removeProductionGanttQueries` below matches on the
 * `["production-gantt", principalId]` prefix.
 */
export function productionGanttKey(identity: DashboardIdentity, scope: "active", filters: ProductionGanttFilters) {
  return ["production-gantt", identity.principalId, identity.role, identity.authorizationEpoch, scope, filters] as const;
}

export function removeProductionGanttQueries(client: QueryClient, principalId: string): void {
  const queryKey = ["production-gantt", principalId] as const;
  void client.cancelQueries({ queryKey });
  client.removeQueries({ queryKey });
}

export type ProductionGanttInfiniteData = InfiniteData<ProductionGanttResponse, string | undefined>;

/**
 * **Contract (fix-218-r2 #1):** a page is read against live data, not a snapshot. A project's
 * sort key (`barStartDate`, derived from its `shoot_date`) can change between the request that
 * minted a cursor and the request that consumes it — a keyset cursor over live data cannot
 * prevent this server-side without a point-in-time snapshot, and this API intentionally does not
 * add one (see `routes/production-gantt.ts` and `packages/shared/src/production-gantt.ts` for the
 * matching server/DTO-side docblocks). Concretely: a row can appear on more than one page of the
 * same walk if its sort key moves across the cursor boundary mid-walk. **Every consumer of
 * multiple Gantt pages must dedupe by id, latest page wins** — the later occurrence carries the
 * freshest data and reflects where the row currently sorts. `flattenGanttProjectPages` and
 * `mergeGanttChildPage` below are the two required call sites for that rule; do not flatten pages
 * any other way.
 */

/**
 * Single-slot memo for `flattenGanttProjectPages` (fix-218-r3 #2): `useInfiniteQuery` grows
 * `pages` by appending one new page per fetch, keeping every earlier page's object reference
 * unchanged. When the incoming `pages` array is an extension of the last array we fully walked
 * (same references at every prior index), we only need to walk the NEW page(s) into the
 * already-built `byId` map, instead of re-walking every accumulated row on every call — that
 * re-walk was the O(n^2 / pageSize) cost this memo removes. Any other shape (a refetch that
 * replaces one or more earlier pages with new objects, a shorter array, an unrelated query's
 * pages) fails the reference check and falls back to a full rebuild, so this is a pure
 * optimization: `flattenGanttProjectPages` always returns the same content for the same input,
 * it just avoids redoing work it already did.
 */
let projectFlattenCache: { pages: readonly ProductionGanttResponse[]; byId: Map<string, GanttProjectRowDto> } | null = null;

function pagesShareIndexablePrefix<T>(prev: readonly T[], next: readonly T[]): boolean {
  if (prev.length > next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

/**
 * `onRowVisit`, when supplied, is called once per project row actually walked into the
 * accumulator (not once per row in the final result) — it exists purely so tests can assert the
 * walk stays linear without depending on wall-clock timing.
 */
export function flattenGanttProjectPages(pages: readonly ProductionGanttResponse[], onRowVisit?: (row: GanttProjectRowDto) => void): GanttProjectRowDto[] {
  const canReuse = projectFlattenCache !== null && pagesShareIndexablePrefix(projectFlattenCache.pages, pages);
  const byId = canReuse ? projectFlattenCache!.byId : new Map<string, GanttProjectRowDto>();
  const startIndex = canReuse ? projectFlattenCache!.pages.length : 0;
  for (const newPage of pages.slice(startIndex)) {
    for (const project of newPage.projects) {
      // Re-inserting an existing key moves it to the end of Map iteration order, so a duplicated
      // id lands at the position of its LATEST occurrence, carrying that occurrence's data.
      byId.delete(project.id);
      byId.set(project.id, project);
      onRowVisit?.(project);
    }
  }
  projectFlattenCache = { pages, byId };
  return [...byId.values()];
}

/**
 * Single-slot memo for `mergeGanttChildPage`, same rationale as `projectFlattenCache` above: a
 * caller re-invokes this with `existingRows` set to ITS OWN previous return value plus one new
 * page, so when `existingRows` is reference-identical to the last array this function produced,
 * we reuse the accumulator instead of rebuilding it from every already-merged row. A caller that
 * passes a fresh `existingRows` (e.g. resetting state on a refetch) misses the cache and gets a
 * correct full rebuild — never stale data.
 */
let childMergeCache: { existingRows: readonly GanttChecklistRowDto[]; byId: Map<string, GanttChecklistRowDto> } | null = null;

/** Same latest-page-wins dedupe rule as `flattenGanttProjectPages`, for a project's children
 * accumulated one child page at a time (`fetchGanttChildPage`). `existingRows` is the
 * already-accumulated list; `page` is the newly fetched page to merge in. `onRowVisit` is the
 * same test-only walk counter as `flattenGanttProjectPages`. */
export function mergeGanttChildPage(existingRows: readonly GanttChecklistRowDto[], page: ProductionGanttChildPageResponse, onRowVisit?: (row: GanttChecklistRowDto) => void): GanttChecklistRowDto[] {
  const canReuse = childMergeCache !== null && childMergeCache.existingRows === existingRows;
  const byId = canReuse ? childMergeCache!.byId : new Map<string, GanttChecklistRowDto>();
  if (!canReuse) {
    for (const row of existingRows) {
      byId.set(row.id, row);
      onRowVisit?.(row);
    }
  }
  for (const row of page.children.rows) {
    byId.delete(row.id);
    byId.set(row.id, row);
    onRowVisit?.(row);
  }
  const result = [...byId.values()];
  childMergeCache = { existingRows: result, byId };
  return result;
}

export type ProductionGanttSelectedData = ProductionGanttInfiniteData & { projects: GanttProjectRowDto[] };

/**
 * Hoisted to module scope (fix-218-r3 #1) so its function identity is stable across renders.
 * `productionGanttInfiniteQueryOptions` is re-invoked on every render of
 * `useProductionGanttProjects`; an inline arrow there would be a brand-new function each time,
 * which defeats TanStack Query's `select` memoization (keyed on select-fn identity + `data`
 * identity) and forces a full re-flatten of every accumulated page on unrelated re-renders.
 */
function selectProductionGanttData(data: ProductionGanttInfiniteData): ProductionGanttSelectedData {
  return { ...data, projects: flattenGanttProjectPages(data.pages) };
}

export function productionGanttInfiniteQueryOptions(identity: DashboardIdentity, filters: ProductionGanttFilters = DEFAULT_FILTERS, enabled = true) {
  const queryKey = productionGanttKey(identity, "active", filters);
  return {
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }: QueryFunctionContext<typeof queryKey, string | undefined>) => {
      const path = `/api/production-gantt?${buildGanttPageQuery(filters, pageParam)}`;
      const response = identity.role === "external_editor"
        ? await externalApiGet("gantt", path, signal)
        : await apiGet<unknown>(path, { signal });
      return decodeProductionGanttResponse(identity.role, response);
    },
    getNextPageParam: (lastPage: ProductionGanttResponse) => lastPage.page.nextCursor ?? undefined,
    // The hook's selected data is always the deduped, flattened project list (fix-218-r2 #1) —
    // callers never flatten `data.pages` themselves. `selectProductionGanttData` is a stable,
    // module-scope reference (fix-218-r3 #1) so TanStack Query can skip re-running it when `data`
    // is unchanged.
    select: selectProductionGanttData,
    enabled,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: projectQueryRetry,
  } as const;
}

export function useProductionGanttProjects(identity: DashboardIdentity, filters: ProductionGanttFilters = DEFAULT_FILTERS, enabled = true): UseInfiniteQueryResult<ProductionGanttSelectedData, Error> {
  const options = productionGanttInfiniteQueryOptions(identity, filters, enabled);
  return useInfiniteQuery<ProductionGanttResponse, Error, ProductionGanttSelectedData, typeof options.queryKey, string | undefined>(options) as UseInfiniteQueryResult<ProductionGanttSelectedData, Error>;
}

/**
 * A plain fetch, not a query: the caller (an expanded Gantt row asking for the remainder of a
 * project's children) owns its own loading/pagination state. The child-page response carries no
 * role-varying field (checklist rows have no `stageKey`), so every role shares one schema — no
 * external projection branch needed, unlike the page endpoint.
 *
 * `completed` selects the child list's own "include done rows" mode for a **first** page (no
 * `childCursor`), matching the page endpoint's own default of `false` when omitted. It is only
 * meaningful there: a continuation's mode is carried inside `childCursor` itself
 * (fix-218-r1 #1), so passing both is a caller error the server rejects with
 * `gantt_query_invalid` — omit `completed` once you have a cursor.
 */
export async function fetchGanttChildPage(projectId: string, childCursor?: string, completed?: boolean, signal?: AbortSignal): Promise<ProductionGanttChildPageResponse> {
  const params = new URLSearchParams({ scope: "active", childrenOf: projectId });
  if (childCursor) params.set("childCursor", childCursor);
  else if (completed) params.set("completed", "1");
  const path = `/api/production-gantt?${params.toString()}`;
  const response = await apiGet<unknown>(path, signal ? { signal } : undefined);
  return productionGanttChildPageSchema.parse(response);
}
