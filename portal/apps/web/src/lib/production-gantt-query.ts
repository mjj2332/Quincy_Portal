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
 * Per-chain memo for `flattenGanttProjectPages` (fix-218-r3 #2, per-chain keying fix-218-r4 #1):
 * `useInfiniteQuery` grows `pages` by immutable append — a new array object per fetch, but every
 * earlier page keeps its own object reference. A `WeakMap` keyed on the `pages` array itself is
 * therefore useless (it's a fresh key every call); instead this keys on `pages[0]`, the first
 * PAGE object, which stays reference-stable across every append within one walk and only changes
 * when a refetch mints a brand-new page one (correctly starting a fresh chain/cache entry). Two
 * or more chains (different filters, different principals, several projects' children) each get
 * their own `WeakMap` entry keyed on their own first page/array, so alternating between them never
 * evicts one chain's accumulator to serve another's — the single-slot version this replaced did.
 * `processedPages` records exactly which pages that entry's `byId` map has walked, validated by
 * reference before extending; any mismatch (an earlier page replaced, a shorter array, a
 * completely different chain that happens to collide — it won't, `WeakMap` keys are exact object
 * identity) falls back to a full, correct rebuild. Pure function of `pages`: same content in,
 * same content out, this just avoids redoing work it already did.
 *
 * **fix-218-r6:** `processedPages` is stored as `pages.slice()` — the caller's OWN array
 * snapshotted, never the caller's live array by reference. If a caller mutated `pages` in place
 * (`pages.push(newPage)` instead of the expected `[...pages, newPage]`), storing the caller's
 * array by reference would let that mutation silently extend `processedPages.length` right along
 * with it, so the next call would see `processedPages.length === pages.length` and skip the
 * pushed page as "already walked" without ever having visited it. A snapshot can't be mutated out
 * from under the cache.
 *
 * **Accepted limit:** this only guards against length changes (push/pop/splice-that-resizes).
 * Same-length in-place element replacement (`pages[0] = otherPage`) is NOT detected — the
 * snapshot's reference at that index still matches `pages`' old reference in memory, but nothing
 * observes the swap without walking every index unconditionally, which is exactly the O(n^2) cost
 * this memo exists to avoid. Every input here is treated as immutable once returned/passed on,
 * matching TanStack Query's own contract (its structural sharing never mutates a `pages` array or
 * a page object in place — it always produces new array/object references); a caller that breaks
 * that contract via same-length in-place replacement is outside what this memo can detect.
 *
 * **Not frozen (fix-218-r6, considered and declined):** `Object.freeze`ing the returned array
 * would change its type from `GanttProjectRowDto[]` to `readonly GanttProjectRowDto[]`, which
 * `ProductionGanttSelectedData.projects` below and every consumer of it would need to widen to
 * match — `packages/shared/src/production-gantt.ts`'s `GanttProjectRowDto`/`ProductionGanttResponse`
 * DTOs type their array fields as plain (non-`readonly`) arrays today, so that widening is NOT a
 * same-file, already-`readonly`-everywhere change. Skipped per the "only if it doesn't cascade"
 * condition; the length/reference guards above are the enforcement instead.
 */
const projectFlattenCache = new WeakMap<ProductionGanttResponse, { processedPages: readonly ProductionGanttResponse[]; byId: Map<string, GanttProjectRowDto> }>();

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
  if (pages.length === 0) return [];
  const firstPage = pages[0]!;
  const cached = projectFlattenCache.get(firstPage);
  const canReuse = cached !== undefined && pagesShareIndexablePrefix(cached.processedPages, pages);
  const byId = canReuse ? cached!.byId : new Map<string, GanttProjectRowDto>();
  const startIndex = canReuse ? cached!.processedPages.length : 0;
  for (const newPage of pages.slice(startIndex)) {
    for (const project of newPage.projects) {
      // Re-inserting an existing key moves it to the end of Map iteration order, so a duplicated
      // id lands at the position of its LATEST occurrence, carrying that occurrence's data.
      byId.delete(project.id);
      byId.set(project.id, project);
      onRowVisit?.(project);
    }
  }
  // fix-218-r6: snapshot, never the caller's live `pages` reference — see docblock above.
  projectFlattenCache.set(firstPage, { processedPages: pages.slice(), byId });
  return [...byId.values()];
}

/**
 * Per-chain memo for `mergeGanttChildPage` (fix-218-r4 #1): keyed on the prior returned
 * `existingRows` array — each expanded project's own child-accumulation chain produces its own
 * distinct array objects, so a `WeakMap` here naturally isolates concurrently-expanded projects'
 * walks from each other (no shared slot to thrash) and lets an abandoned chain's entry be
 * collected once nothing still references its `existingRows`. A caller that passes a fresh
 * `existingRows` (e.g. resetting state on a refetch) misses the cache and gets a correct full
 * rebuild — never stale data.
 *
 * **fix-218-r5 #1:** reusing a cached entry means MUTATING its `Map` in place (the whole point of
 * the memo — see below), which is only safe if that `Map` is retired from the cache the moment
 * it's reused: `existingRows`' entry is deleted before its `byId` is touched, transferring
 * ownership to the new result. Without that delete, a SECOND call from the same `existingRows`
 * (a retried/branched continuation — the same accumulated base re-extended with a different next
 * page) would read the first branch's already-mutated `Map` back out of the cache and silently
 * carry that branch's rows into a walk that never asked for them. Deleting on reuse makes a
 * second read of the same parent a correct, if uncached, full rebuild instead.
 *
 * **fix-218-r6:** the cache KEY here is the array `mergeGanttChildPage` itself returned — unlike
 * `projectFlattenCache` above, there is no separate anchor object to snapshot against. If a
 * caller mutates that returned array in place (`base.push(row)`) instead of treating it as
 * immutable, the array's `.length` changes but its identity doesn't, so a later
 * `childMergeCache.get(existingRows)` would still hit and hand back a `byId` that never saw the
 * pushed row. `length` is recorded alongside `byId` at cache-set time and re-checked at lookup: a
 * mismatch is treated as a miss, forcing a full, correct rebuild from the (now-mutated)
 * `existingRows` array's actual current content.
 *
 * **Accepted limit:** only a length change is detected. Same-length in-place element replacement
 * (`existingRows[0] = otherRow`) is not — this function treats every array it's handed as
 * immutable once returned, the same contract TanStack Query's own structural sharing relies on
 * (it never mutates a page or accumulated array in place; it always produces new references).
 *
 * **Not frozen (fix-218-r6, considered and declined):** same reasoning as `flattenGanttProjectPages`
 * above — `GanttChecklistRowDto`'s array fields (`GanttProjectRowDto["children"]["rows"]` in
 * `packages/shared/src/production-gantt.ts`) are plain arrays, not `readonly`, so freezing here
 * would cascade a type widening beyond this file. Skipped; the length guard above is the
 * enforcement instead.
 */
const childMergeCache = new WeakMap<readonly GanttChecklistRowDto[], { length: number; byId: Map<string, GanttChecklistRowDto> }>();

/** Same latest-page-wins dedupe rule as `flattenGanttProjectPages`, for a project's children
 * accumulated one child page at a time (`fetchGanttChildPage`). `existingRows` is the
 * already-accumulated list; `page` is the newly fetched page to merge in. `onRowVisit` is the
 * same test-only walk counter as `flattenGanttProjectPages`. */
export function mergeGanttChildPage(existingRows: readonly GanttChecklistRowDto[], page: ProductionGanttChildPageResponse, onRowVisit?: (row: GanttChecklistRowDto) => void): GanttChecklistRowDto[] {
  const cachedEntry = childMergeCache.get(existingRows);
  // fix-218-r6: a length mismatch means `existingRows` was mutated in place since it was cached
  // (e.g. `.push`) — treat it exactly like a cache miss below, never reuse `cachedEntry.byId`.
  const canReuse = cachedEntry !== undefined && cachedEntry.length === existingRows.length;
  const byId = canReuse ? cachedEntry!.byId : new Map<string, GanttChecklistRowDto>();
  if (canReuse) {
    // Ownership transfer (fix-218-r5 #1): about to mutate `byId` in place, so the entry keyed on
    // `existingRows` must not keep pointing at it — a second, branched call from this same
    // `existingRows` must miss and rebuild, not observe THIS call's mutation.
    childMergeCache.delete(existingRows);
  } else {
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
  childMergeCache.set(result, { length: result.length, byId });
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
