import {
  normalizeProductionCalendarSearch,
  PRODUCTION_CALENDAR_LAYERS,
  PRODUCTION_CALENDAR_MAX_EDITOR_IDS,
  PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES,
  PRODUCTION_CALENDAR_MAX_STAGE_KEYS,
  PRODUCTION_CALENDAR_SUBVIEWS,
  productionCalendarFiltersSchema,
} from "./production-calendar";
import { isSydneyCalendarDate } from "./sydney-civil-time";
import { STAGE_PRESENTATION_KEYS, type StagePresentationKey } from "./stage-move";
import { notificationWorkspaceTab } from "./notification-types";
import { WORKSPACE_TABS, type WorkspaceTab } from "./workspace-tab";

/**
 * The small, deliberately closed URL contract for the authenticated staff SPA.
 * UUID casing is a parser convention: IDs generated and stored by this app are
 * lowercase, while the API's general UUID validator intentionally accepts more.
 */
export type DashboardCalendarState = {
  view: "calendar";
  date: string;
  subview: (typeof PRODUCTION_CALENDAR_SUBVIEWS)[number];
  layers: Array<(typeof PRODUCTION_CALENDAR_LAYERS)[number]>;
  editorIds: string[];
  includeUnassigned: boolean;
  stageKeys: StagePresentationKey[];
  showCompletedChecklist: boolean;
  showDeliveredProjects: boolean;
  overdueOnly: boolean;
  search: string;
  myTasks: boolean;
};

/**
 * The `view` allow-list is closed to `table`, `board`, `timeline` and `calendar` (plus the retired `list`, `kanban` and `gantt` spellings, accepted on parse only — #427). `kanban2` (#80) was a second Board
 * value on this same grammar, used for comparison against real studio data before cutover (#76
 * "Slice order"); the cutover (#83) retired it as a legal `view` value entirely — `/?view=kanban2`
 * now falls through to `not-found`, not to a redirect or a normalisation.
 *
 * `calendar` joined the allow-list in #111 and is not symmetrical with the others. `table` and
 * `board` are destinations; a bare `/?view=calendar` is an *intent*, legal as the sole query
 * field OR paired with exactly one `q` (#217 fix round 4, item 1 -- `DashboardCalendarIntentRoute`'s
 * own docblock has why). The navigation rail links to it and the Dashboard canonicalises it to the
 * parameterised facet URL that `DashboardCalendarFacetRoute` describes, using the remembered
 * subview and last date it already reads. The rail resolving those preferences itself was
 * rejected: it would put the preference logic in two places. The accepted cost is one URL rewrite
 * on arrival, which is why this spelling should never be observed in the address bar for more than
 * a commit.
 */
/**
 * List/Kanban carry the Dashboard's own `q` (#217) and nothing else — optional `q`, no facet
 * params, no subview/date keys (unlike Calendar's own two-shape grammar below).
 *
 * Gantt used to share this type and parser arm (#220, when it had no facets of its own). #255 gave
 * it Stage / Delivered / Completed filters, so it now has its own arm, `DashboardGanttRoute`
 * below, rather than an optional facet field bolted onto this one: this arm's serializer only
 * writes `view` and `q`, so a facet field here would be representable in a route value yet
 * silently dropped on the way to the URL. A separate arm makes that state unrepresentable — the
 * List/Kanban serializer can never be handed a field it would discard.
 */
export type DashboardTableBoardRoute = {
  kind: "dashboard";
  dashboardView: "table" | "board";
  search?: string;
};

/** The Gantt's own URL filter state (#255). Absent on the route whenever every facet is default. */
export type DashboardGanttFacet = {
  stageKeys: StagePresentationKey[];
  delivered: boolean;
  completed: boolean;
  /** #274: the Editor field, sorted canonical lowercase UUIDs. */
  editorIds: string[];
};

/**
 * The Gantt arm (#255): `view=gantt`, an optional `q`, and the Gantt's own facets — `stages`,
 * `delivered=1`, `completed=1` — parsed with the Calendar arm's own list/flag parsers and caps, so a
 * duplicate key, a duplicate or unknown stage, `delivered=0`, or any other key is `not-found`
 * exactly as it is there. `gantt` is omitted whenever every facet is default
 * (`isDefaultGanttFacet`), so the bare `/?view=gantt` has exactly one route value and the
 * serialize -> parse -> serialize round trip is a fixed point. The Gantt's filter state is
 * independent of the Calendar's: the two arms never read each other's parameters.
 */
export type DashboardTimelineRoute = {
  kind: "dashboard";
  dashboardView: "timeline";
  search?: string;
  gantt?: DashboardGanttFacet;
};

/**
 * The bare `/?view=calendar` intent (#111) -- CAN carry a `search` field, as of #217 fix round 4,
 * item 1 (Sol re-review). Round 3, item 3 made `{ dashboardView: "calendar", search }`
 * unrepresentable specifically because `staffPathFor` could serialize it to
 * `/?view=calendar&q=...` while `parseStaffLocation` rejected that exact spelling outright -- a
 * route the serializer could produce but the parser could never read back. That analysis was
 * right about the MISMATCH; the fix it chose (forbid the state) turned out to be the wrong side of
 * it. The rail's Calendar link is a plain `<a href>` the browser also owns: keyboard Enter (not
 * intercepted -- `router.ts`'s own `shouldInterceptInternalLink` only claims a genuine left-click),
 * cmd/middle-click, "open in new tab" and a reload all load `href` as a fresh document, with a
 * COLD, empty `lib/dashboard-search-store.ts` singleton -- so a canonicaliser that could only read
 * the in-memory store from that intent lost the search on every one of those paths. The fix this
 * round makes instead: `/?view=calendar&q=<text>` is now a legal INTENT spelling too (the parser
 * accepts `view` plus, optionally, exactly one `q` -- still rejecting every partial facet, exactly
 * as before), so the search survives in the URL itself regardless of how the browser got there.
 * `Dashboard.tsx`'s one full-facet rewrite still owns carrying it into the concrete Calendar URL —
 * that part of item 1's round-3 design was already right — but now reads it FROM THE ROUTE first,
 * falling back to the live store only for a draft still in flight during an intercepted SPA click.
 */
export type DashboardCalendarIntentRoute = {
  kind: "dashboard";
  dashboardView: "calendar";
  search?: string;
};

export type DashboardViewRoute = DashboardTableBoardRoute | DashboardTimelineRoute | DashboardCalendarIntentRoute;

export type DashboardCalendarFacetRoute = {
  kind: "dashboard";
  calendar: DashboardCalendarState;
};

export type DashboardRoute =
  | { kind: "dashboard"; search?: string }
  | DashboardViewRoute
  | DashboardCalendarFacetRoute;

export type StaffRoute =
  | DashboardRoute
  | { kind: "create-project" }
  /** `arrivalTab` is the Workspace tab the URL names (#337 arrival; persistent since #367: the
   * Workspace keeps the URL naming the tab it shows). */
  | { kind: "project"; projectId: string; arrivalTab?: WorkspaceTab }
  | { kind: "edit-project"; projectId: string }
  | { kind: "admin" }
  | { kind: "notices" }
  | { kind: "notifications" }
  | { kind: "notification-preferences" }
  | { kind: "not-found" }
  | { kind: "reserved" };

export const CANONICAL_LOWERCASE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID = CANONICAL_LOWERCASE_UUID_REGEX;
const reservedRoots = new Set(["api", "media", "__transform-source", "d"]);
/**
 * #337: the one query string each Workspace tab's arrival intent is spelled as. Collaboration's
 * `collaboration=open` is FROZEN: `projectActivityDeepLink` (project-activity.ts) builds its
 * expected deep link through `staffPathFor`, and `parseProjectActivityRow` rejects any persisted
 * `deep_link_path` that is not byte-equal -- a new spelling would invalidate every stored
 * `project_collaboration` activity row and in-flight outbox payload. `tab=collaboration` is
 * deliberately NOT accepted: one spelling per tab keeps parse/serialise a strict round trip.
 */
function projectArrivalQuery(tab: WorkspaceTab): string {
  return tab === "collaboration" ? "collaboration=open" : `tab=${tab}`;
}
const PROJECT_ARRIVAL_BY_QUERY: ReadonlyMap<string, WorkspaceTab> = new Map(
  WORKSPACE_TABS.map((tab) => [projectArrivalQuery(tab), tab]),
);
const calendarParameterNames = new Set([
  "view", "date", "sub", "layers", "editors", "unassigned", "stages", "completed", "delivered", "overdue", "mine", "q",
]);
const dashboardTableBoardParameterNames = new Set(["view", "q"]);
const dashboardTimelineParameterNames = new Set(["view", "q", "editors", "stages", "delivered", "completed"]);
const calendarFilterDefaults = productionCalendarFiltersSchema.parse({});

/** Shared with the Calendar facet's own `q` (`calendarPathFor`'s `normalizeDashboardSearchText`
 * call, `~432`) so both enforce the same cap. */
export const DASHBOARD_SEARCH_MAX_CHARS = 200;

function unsafeText(value: string): boolean {
  return /[\\\u0000-\u001f\u007f]/.test(value);
}

/**
 * Serialization-side guard: drops exactly the characters `unsafeText` rejects on
 * parse, so `calendarPathFor` -> `parseStaffLocation` is a fixed point regardless
 * of whether the caller pre-sanitized the free-text search. Without it a stored
 * `search` containing a backslash serializes to `?q=%5C`, fails the parse guard,
 * and collapses `safeStaffDestination` to `/`.
 */
export function stripUnsafeText(value: string): string {
  return Array.from(value).filter((char) => !unsafeText(char)).join("");
}

/**
 * Caps a search value to `DASHBOARD_SEARCH_MAX_CHARS` code points -- the ONE definition
 * `calendarPathFor`/`staffPathFor` below, `apps/web/src/lib/dashboard-search-store.ts`'s own
 * commit path, and the worker's `/api/projects?q=` matcher (`workers/app/src/routes/projects.ts`)
 * all share, so the 200-char cap can never drift between them (#217 fix round 3, items 3 and 4;
 * `workers/app/src/lib/project-search.ts`'s own `PROJECT_SEARCH_MAX_LENGTH` stays a separate
 * constant — that file is an unmodified #218 cherry-pick — but a worker test asserts the two stay
 * numerically equal). Serializing an over-limit search used to emit a `q` the parser then rejected
 * outright, collapsing the whole route to `not-found` rather than a capped, still-legal one; this
 * is what makes the serializer total over every `search` a caller passes it, not only the ones
 * already known to be short enough.
 */
export function capDashboardSearchText(value: string): string {
  const chars = [...value];
  return chars.length > DASHBOARD_SEARCH_MAX_CHARS ? chars.slice(0, DASHBOARD_SEARCH_MAX_CHARS).join("") : value;
}

/**
 * The ONE shared normaliser for a Dashboard search value: strip unsafe characters, collapse/trim
 * whitespace, then cap -- #217 fix round 4, item 2 (Sol re-review). `staffPathFor`/`calendarPathFor`
 * below used to only strip and cap (#217 fix round 3), so a raw, not-yet-committed draft
 * (`"  smith   street  "`, reaching a URL straight from `apps/web/src/lib/app-router.tsx`'s rail
 * hrefs before this fix) served AND parsed back as that exact raw text — never actually collapsed
 * to the same value `dashboard-search-store.ts`'s own commit path produces, so the URL and the
 * store's own committed `query` could disagree on what "the same search" even looks like. Every
 * href/URL this module builds from a live (possibly still-mid-keystroke) search now goes through
 * this one function, so no caller can reproduce that drift by getting the composition order wrong.
 * Idempotent by construction (strip/trim/collapse/cap are each idempotent), which is what keeps
 * `staffPathFor(parseStaffLocation(staffPathFor(x))) === staffPathFor(x)` a fixed point: the parser
 * itself stays a strict reader of whatever raw text is in `q` — it does not also need to normalise
 * — because the SERIALIZER's own output is already normalised, and normalising it again is a no-op.
 */
export function normalizeDashboardSearchText(value: string): string {
  return capDashboardSearchText(normalizeProductionCalendarSearch(stripUnsafeText(value)));
}

/** Parse an unescaped pathname only; query and hash are intentionally out of contract. */
export function parseStaffPathname(pathname: string): StaffRoute {
  if (!pathname.startsWith("/") || pathname.includes("?") || pathname.includes("#") || unsafeText(pathname)) return { kind: "not-found" };
  if (pathname === "/") return { kind: "dashboard" };
  // Namespace reservations take precedence even for a trailing slash: they must
  // never become staff SPA candidates while delivery/backend services own them.
  if (["d", "api", "media", "__transform-source"].some((root) => pathname === `/${root}` || pathname.startsWith(`/${root}/`))) return { kind: "reserved" };
  if (pathname.endsWith("/") || pathname.includes("//")) return { kind: "not-found" };

  const rawSegments = pathname.slice(1).split("/");
  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return { kind: "not-found" };
  }
  // Canonical staff paths do not contain escapes. This also rejects encoded static
  // spellings, encoded separators, and alternative UUID spellings before matching.
  if (segments.some((segment, index) => segment !== rawSegments[index] || !segment || unsafeText(segment) || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))) return { kind: "not-found" };
  if (reservedRoots.has(segments[0]!)) return { kind: "reserved" };

  if (segments.length === 1 && segments[0] === "admin") return { kind: "admin" };
  if (segments.length === 1 && segments[0] === "notices") return { kind: "notices" };
  // Checked BEFORE the 2-segment "notifications" arm below: both share the same two leading
  // segments, so the longer, more specific match must win or it would never be reached.
  if (segments.length === 3 && segments[0] === "settings" && segments[1] === "notifications" && segments[2] === "preferences") return { kind: "notification-preferences" };
  if (segments.length === 2 && segments[0] === "settings" && segments[1] === "notifications") return { kind: "notifications" };
  if (segments[0] !== "projects") return { kind: "not-found" };
  if (segments.length === 2 && segments[1] === "new") return { kind: "create-project" };
  if (!UUID.test(segments[1] ?? "")) return { kind: "not-found" };
  if (segments.length === 2) return { kind: "project", projectId: segments[1]! };
  if (segments.length === 3 && segments[2] === "edit") return { kind: "edit-project", projectId: segments[1]! };
  return { kind: "not-found" };
}

function hasMalformedQueryEncoding(query: string): boolean {
  // URLSearchParams replaces malformed escapes with U+FFFD instead of throwing.
  // Validate each raw component first so the closed route contract never accepts
  // a lossy decode.
  if (query === "" || query.split("&").some((part) => part === "")) return true;
  for (const part of query.split("&")) {
    const equals = part.indexOf("=");
    const rawName = equals === -1 ? part : part.slice(0, equals);
    const rawValue = equals === -1 ? "" : part.slice(equals + 1);
    try {
      decodeURIComponent(rawName);
      decodeURIComponent(rawValue);
    } catch {
      return true;
    }
  }
  return false;
}

function decodeQueryComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/gu, " "));
}

/**
 * Parse the common Dashboard query boundary before dispatching to a route arm.
 * URLSearchParams accepts several equivalent spellings, but staff locations only
 * accept the spelling emitted by URLSearchParams itself. Ordering remains a
 * serializer concern, so callers may still supply parameters in any order.
 */
function parseDashboardQuery(query: string): URLSearchParams | null {
  if (new TextEncoder().encode(query).byteLength > PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES || hasMalformedQueryEncoding(query)) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }

  const seen = new Set<string>();
  for (const part of query.split("&")) {
    const equals = part.indexOf("=");
    const rawName = equals === -1 ? part : part.slice(0, equals);
    const rawValue = equals === -1 ? "" : part.slice(equals + 1);
    try {
      const name = decodeQueryComponent(rawName);
      const value = decodeQueryComponent(rawValue);
      if (unsafeText(name) || unsafeText(value) || seen.has(name)) return null;
      seen.add(name);
      const canonicalPart = new URLSearchParams([[name, value]]).toString();
      if (canonicalPart !== `${rawName}=${rawValue}`) return null;
    } catch {
      return null;
    }
  }
  return params;
}

function canonicalKnownList<T extends string>(values: readonly T[], order: readonly T[]): T[] {
  const unique = new Set(values);
  return order.filter((value) => unique.has(value));
}

function parseCalendarList(value: string | null): string[] | null {
  if (value === null || value === "") return null;
  const values = value.split(",");
  if (values.some((item) => item === "") || new Set(values).size !== values.length) return null;
  return values;
}

function parseCalendarFlag(params: URLSearchParams, name: string): boolean | null {
  if (!params.has(name)) return false;
  return params.get(name) === "1" ? true : null;
}

function parseCalendarLocation(params: URLSearchParams): DashboardCalendarState | null {
  // Decoded-value safety and duplicate rejection are handled by parseDashboardQuery; this
  // arm only enforces its own closed parameter allow-list.
  for (const name of params.keys()) {
    if (!calendarParameterNames.has(name)) return null;
  }
  if (params.get("view") !== "calendar") return null;

  const date = params.get("date");
  const subview = params.get("sub");
  const rawLayers = parseCalendarList(params.get("layers"));
  if (date === null || !isSydneyCalendarDate(date) || subview === null || !PRODUCTION_CALENDAR_SUBVIEWS.includes(subview as (typeof PRODUCTION_CALENDAR_SUBVIEWS)[number]) || rawLayers === null) return null;
  if (rawLayers.some((value) => !PRODUCTION_CALENDAR_LAYERS.includes(value as (typeof PRODUCTION_CALENDAR_LAYERS)[number]))) return null;
  const layers = canonicalKnownList(rawLayers as Array<(typeof PRODUCTION_CALENDAR_LAYERS)[number]>, PRODUCTION_CALENDAR_LAYERS);
  if (layers.length === 0) return null;

  const editorIds = parseEditorIdsParam(params);
  if (editorIds === null) return null;

  const stageKeys = parseStageKeysParam(params);
  if (stageKeys === null) return null;

  const includeUnassigned = parseCalendarFlag(params, "unassigned");
  const showCompletedChecklist = parseCalendarFlag(params, "completed");
  const showDeliveredProjects = parseCalendarFlag(params, "delivered");
  const overdueOnly = parseCalendarFlag(params, "overdue");
  const myTasks = parseCalendarFlag(params, "mine");
  if (includeUnassigned === null || showCompletedChecklist === null || showDeliveredProjects === null || overdueOnly === null || myTasks === null) return null;

  const rawSearch = params.get("q") ?? "";
  if ([...rawSearch].length > DASHBOARD_SEARCH_MAX_CHARS) return null;
  // #217 fix round 5, item 4 (Sol re-review): normalized here too -- a freshly-typed, padded `q`
  // on the calendar facet must read back as the same value the store's own commit path and
  // `calendarPathFor` would both produce, not the raw spacing.
  const search = normalizeDashboardSearchText(rawSearch);

  return {
    view: "calendar",
    date,
    subview: subview as DashboardCalendarState["subview"],
    layers,
    editorIds,
    includeUnassigned,
    stageKeys,
    showCompletedChecklist,
    showDeliveredProjects,
    overdueOnly,
    search,
    myTasks,
  };
}

/**
 * `undefined` = `q` absent OR normalizes to no search (legal, both read the same way); `null` =
 * reject. Reject an empty raw `q` -- the serializer never emits one, so accepting it would break
 * the `staffPathFor` -> `parseStaffLocation` fixed point -- or a raw value over
 * `DASHBOARD_SEARCH_MAX_CHARS` code points (checked on the RAW value, before normalising, so an
 * over-limit `q` still rejects the whole route rather than silently truncating it). Unsafe
 * characters, duplicate keys, non-canonical percent-encoding and an oversized query are already
 * rejected upstream by `parseDashboardQuery`; this helper does not re-check them.
 *
 * #217 fix round 5, item 4 (Sol re-review, SHOULD-FIX). A within-limit but otherwise raw `q` --
 * padded, multi-space, e.g. a freshly-typed `/?q=++smith+++street++` that was never something
 * `staffPathFor`/`dashboard-search-store.ts`'s own commit path would themselves have emitted --
 * used to be returned exactly as written, disagreeing with what the SAME text normalises to
 * everywhere else in the app. Every `q` this function accepts now goes through the one shared
 * `normalizeDashboardSearchText`, the same normaliser the serializer already uses -- so a value
 * that normalizes down to "" (all-whitespace) reads as "no search", identically to `q` being
 * absent, rather than a rejected route.
 */
function parseDashboardSearch(params: URLSearchParams): string | null | undefined {
  if (!params.has("q")) return undefined;
  const value = params.get("q")!;
  if (value === "" || [...value].length > DASHBOARD_SEARCH_MAX_CHARS) return null;
  const normalized = normalizeDashboardSearchText(value);
  return normalized === "" ? undefined : normalized;
}

/** #427: `list` and `kanban` are the retired spellings of `table` and `board` (and `gantt` of
 * `timeline`). They still PARSE, to the new value, so an old bookmark, an old-bundle tab or a
 * stored OAuth return lands on the right view; `staffPathFor` only ever EMITS the new spellings. */
const LEGACY_DASHBOARD_VIEW_SPELLINGS: Readonly<Record<string, "table" | "board" | "timeline">> = {
  list: "table",
  kanban: "board",
  gantt: "timeline",
};

function parseDashboardTableBoardLocation(params: URLSearchParams): DashboardTableBoardRoute | null {
  for (const name of params.keys()) {
    if (!dashboardTableBoardParameterNames.has(name)) return null;
  }
  const rawView = params.get("view") ?? "";
  const dashboardView = LEGACY_DASHBOARD_VIEW_SPELLINGS[rawView] ?? rawView;
  if (dashboardView !== "table" && dashboardView !== "board") return null;
  const search = parseDashboardSearch(params);
  if (search === null) return null;

  return { kind: "dashboard", dashboardView, ...(search ? { search } : {}) };
}

/** The ONE definition of "every Gantt facet is at its default" (#255) — the parser and the web
 * app's own route builder both use it, so "default means absent" cannot drift. (The serializer
 * writes only non-default params field by field, so an all-default facet writes nothing.) */
export function isDefaultGanttFacet(facet: DashboardGanttFacet | undefined): boolean {
  return facet === undefined || (facet.stageKeys.length === 0 && !facet.delivered && !facet.completed && facet.editorIds.length === 0);
}

/** Parses the `editors` list with the Calendar arm's rules (lowercase UUIDs, no duplicates, the
 * shared cap) and returns it sorted, so both arms canonicalise it the same way (#274). */
function parseEditorIdsParam(params: URLSearchParams): string[] | null {
  const rawEditors = params.get("editors");
  const editorValues = rawEditors === null ? [] : parseCalendarList(rawEditors);
  if (editorValues === null || editorValues.length > PRODUCTION_CALENDAR_MAX_EDITOR_IDS || editorValues.some((value) => !UUID.test(value)) || new Set(editorValues).size !== editorValues.length) return null;
  return [...editorValues].sort();
}

/** Parses the stage list with the Calendar arm's own parser, cap and canonical order. */
function parseStageKeysParam(params: URLSearchParams): StagePresentationKey[] | null {
  const rawStages = params.get("stages");
  const stageValues = rawStages === null ? [] : parseCalendarList(rawStages);
  if (stageValues === null || stageValues.length > PRODUCTION_CALENDAR_MAX_STAGE_KEYS || stageValues.some((value) => !STAGE_PRESENTATION_KEYS.includes(value as StagePresentationKey)) || new Set(stageValues).size !== stageValues.length) return null;
  return canonicalKnownList(stageValues as StagePresentationKey[], STAGE_PRESENTATION_KEYS);
}

function parseDashboardTimelineLocation(params: URLSearchParams): DashboardTimelineRoute | null {
  for (const name of params.keys()) {
    if (!dashboardTimelineParameterNames.has(name)) return null;
  }
  const rawView = params.get("view");
  if (rawView !== "timeline" && rawView !== "gantt") return null;
  const editorIds = parseEditorIdsParam(params);
  const stageKeys = parseStageKeysParam(params);
  const delivered = parseCalendarFlag(params, "delivered");
  const completed = parseCalendarFlag(params, "completed");
  if (editorIds === null || stageKeys === null || delivered === null || completed === null) return null;
  const search = parseDashboardSearch(params);
  if (search === null) return null;
  const gantt: DashboardGanttFacet = { stageKeys, delivered, completed, editorIds };
  return { kind: "dashboard", dashboardView: "timeline", ...(search ? { search } : {}), ...(isDefaultGanttFacet(gantt) ? {} : { gantt }) };
}

/** Parse the complete, canonical relative staff location. Queries stay closed except for
 * the Workspace tab the URL names (persistent since #367) on an otherwise canonical project route:
 * `?collaboration=open` (Collaboration's only spelling -- frozen by persisted activity deep links,
 * see `projectArrivalQuery`) or `?tab=<collection kind>`. */
export function parseStaffLocation(location: string): StaffRoute {
  if (typeof location !== "string" || unsafeText(location) || location.includes("#")) return { kind: "not-found" };
  const question = location.indexOf("?");
  if (question === -1) return parseStaffPathname(location);
  const pathname = location.slice(0, question);
  const query = location.slice(question + 1);
  const route = parseStaffPathname(pathname);
  if (route.kind === "project") {
    const arrivalTab = PROJECT_ARRIVAL_BY_QUERY.get(query);
    return arrivalTab ? { ...route, arrivalTab } : { kind: "not-found" };
  }
  if (route.kind !== "dashboard" || pathname !== "/") return { kind: "not-found" };
  const params = parseDashboardQuery(query);
  if (params === null) return { kind: "not-found" };
  const view = params.get("view");
  if (!params.has("view")) {
    // Bare `/?q=...`: the only legal key here is `q` itself -- everything else (including a
    // `view` spelling this arm didn't already claim) falls through to `not-found` below.
    for (const name of params.keys()) {
      if (name !== "q") return { kind: "not-found" };
    }
    const search = parseDashboardSearch(params);
    if (search === null) return { kind: "not-found" };
    // #217 fix round 5, item 4: `undefined` now also covers a `q` that NORMALIZES to no search
    // (all-whitespace) -- that reads as the plain bare route, not a rejection, the same way `q`
    // being entirely absent already did.
    return { kind: "dashboard", ...(search !== undefined ? { search } : {}) };
  }
  if (view === "table" || view === "board" || view === "list" || view === "kanban") return parseDashboardTableBoardLocation(params) ?? { kind: "not-found" };
  if (view === "timeline" || view === "gantt") return parseDashboardTimelineLocation(params) ?? { kind: "not-found" };
  if (view === "calendar") {
    // The bare `/?view=calendar` intent (#111), legal as the sole query field or paired with
    // exactly one `q` (#217 fix round 4, item 1 -- see `DashboardCalendarIntentRoute`'s own
    // docblock for why). Checked before `parseCalendarLocation` because that function requires a
    // complete facet — a date, a subview and a non-empty layer list — and would reject this
    // spelling. Every partial facet still falls through to it and is still rejected: accepting
    // `view=calendar` plus *some* of its parameters (other than `q`) would silently discard the
    // rest. Duplicate keys, a trailing `&`, an oversized query and non-canonical percent-encoding
    // are already rejected by `parseDashboardQuery` above, so this arm inherits all of that and
    // only has to count and name the keys.
    const keys = [...params.keys()];
    if (keys.length === 1 || (keys.length === 2 && params.has("q"))) {
      const search = parseDashboardSearch(params);
      if (search === null) return { kind: "not-found" };
      return { kind: "dashboard", dashboardView: "calendar", ...(search ? { search } : {}) };
    }
    const calendar = parseCalendarLocation(params);
    if (calendar === null) return { kind: "not-found" };
    return { kind: "dashboard", calendar };
  }
  return { kind: "not-found" };
}

/**
 * #427: the canonical path for a Dashboard location whose raw `view` is a retired spelling
 * (`list`, `kanban`, `gantt`), or `null` for everything else. The shell replaces the URL with this
 * once, so an old bookmark does not stay in the address bar. It is deliberately NOT
 * `staffPathFor(route) !== location`: that would also rewrite Calendar's accepted parameter orders
 * and any other spelling the parser tolerates, which are not this migration's business.
 */
export function canonicalLegacyDashboardLocation(location: string): string | null {
  if (typeof location !== "string") return null;
  const question = location.indexOf("?");
  if (question === -1 || location.slice(0, question) !== "/") return null;
  const query = location.slice(question + 1);
  let rawView: string | null = null;
  for (const part of query.split("&")) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    if (part.slice(0, equals) === "view") rawView = part.slice(equals + 1);
  }
  if (rawView === null || !Object.hasOwn(LEGACY_DASHBOARD_VIEW_SPELLINGS, rawView)) return null;
  const route = parseStaffLocation(location);
  if (route.kind !== "dashboard") return null;
  return staffPathFor(route);
}

/**
 * The ONE accessor for "what committed search does this route carry" — #217 build, step 2. Every
 * Dashboard route arm's own `search` (bare/List/Kanban/the Calendar intent) or the Calendar
 * facet's own `calendar.search` is already normalised by the parser (`parseDashboardSearch`/
 * `parseCalendarLocation`'s own `normalizeDashboardSearchText` calls above) before it ever reaches
 * here, so this never re-normalises. `undefined` for any non-Dashboard route, and for a Dashboard
 * route that carries no `q` at all — never `""` for "absent" (the Calendar facet's own `search` is
 * a required `string`, so an intentionally-empty facet search is a real `""`, distinguishable from
 * "the route carries no search field").
 */
export function dashboardSearchOf(route: StaffRoute): string | undefined {
  if (route.kind !== "dashboard") return undefined;
  if ("calendar" in route) return route.calendar.search;
  return route.search;
}

function serializedList(values: readonly string[], order: readonly string[]): string {
  const unique = [...new Set(values)];
  const rank = new Map(order.map((value, index) => [value, index]));
  unique.sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return unique.join(",");
}

/** Writes the `stages` / `completed=1` / `delivered=1` params the Calendar and Gantt arms share, in
 * that order and only when non-default — the serializing counterpart of `parseStageKeysParam`. */
function setStageAndFlagParams(params: URLSearchParams, facet: { stageKeys: readonly StagePresentationKey[]; completed: boolean; delivered: boolean }): void {
  if (facet.stageKeys.length > 0) params.set("stages", serializedList(facet.stageKeys, STAGE_PRESENTATION_KEYS));
  if (facet.completed) params.set("completed", "1");
  if (facet.delivered) params.set("delivered", "1");
}

function calendarPathFor(calendar: DashboardCalendarState): string {
  const params = new URLSearchParams();
  params.set("view", "calendar");
  params.set("date", calendar.date);
  params.set("sub", calendar.subview);
  params.set("layers", serializedList(calendar.layers, PRODUCTION_CALENDAR_LAYERS));
  if (calendar.editorIds.length > 0) params.set("editors", serializedList(calendar.editorIds, []));
  if (calendar.includeUnassigned !== calendarFilterDefaults.includeUnassigned) params.set("unassigned", "1");
  setStageAndFlagParams(params, { stageKeys: calendar.stageKeys, completed: calendar.showCompletedChecklist, delivered: calendar.showDeliveredProjects });
  if (calendar.overdueOnly !== calendarFilterDefaults.overdueOnly) params.set("overdue", "1");
  if (calendar.myTasks !== calendarFilterDefaults.myTasks) params.set("mine", "1");
  // #217 fix round 3, item 3 / round 4, item 2: normalised (strip, collapse whitespace, trim, cap)
  // through the one shared `normalizeDashboardSearchText`, not just stripped and capped -- a raw
  // draft's stray whitespace must never reach the URL differently than the store's own debounced
  // URL write would put there.
  const safeSearch = normalizeDashboardSearchText(calendar.search);
  if (safeSearch !== calendarFilterDefaults.search) params.set("q", safeSearch);
  return `/?${params.toString()}`;
}

export function staffPathFor(route: Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>): string {
  switch (route.kind) {
    case "dashboard": {
      if ("calendar" in route) return calendarPathFor(route.calendar);
      const params = new URLSearchParams();
      // `search` exists on every arm here now (#217 fix round 4, item 1 gave the Calendar INTENT
      // arm one too), so it is read from `route` uniformly.
      if ("dashboardView" in route) params.set("view", route.dashboardView);
      // #255: the Gantt arm's own facets, through the same writer the Calendar arm uses for its
      // `stages`/`completed`/`delivered` — only non-default values, so an all-default facet
      // serialises to the bare `/?view=gantt`.
      if ("gantt" in route && route.gantt) {
        // #274: `editors` before `stages`, the Calendar arm's order.
        if (route.gantt.editorIds.length > 0) params.set("editors", serializedList(route.gantt.editorIds, []));
        setStageAndFlagParams(params, route.gantt);
      }
      const search = route.search;
      if (search !== undefined) {
        const safeSearch = normalizeDashboardSearchText(search);
        if (safeSearch !== "") params.set("q", safeSearch);
      }
      const qs = params.toString();
      return qs ? `/?${qs}` : "/";
    }
    case "create-project": return "/projects/new";
    case "project": return `/projects/${encodeURIComponent(route.projectId)}${route.arrivalTab ? `?${projectArrivalQuery(route.arrivalTab)}` : ""}`;
    case "edit-project": return `/projects/${encodeURIComponent(route.projectId)}/edit`;
    case "admin": return "/admin";
    case "notices": return "/notices";
    case "notifications": return "/settings/notifications";
    case "notification-preferences": return "/settings/notifications/preferences";
  }
}

/** The canonical staff-app destination for a project-scoped notification, or undefined if the
 * notification has no project (e.g. a notice-board mention). */
export function projectNotificationRoute(projectId: string | null, type: string): StaffRoute | undefined {
  if (!projectId) return undefined;
  const arrivalTab = notificationWorkspaceTab(type);
  return { kind: "project", projectId, ...(arrivalTab ? { arrivalTab } : {}) };
}

/** Only canonical, relative staff locations are valid OAuth return destinations. */
export function safeStaffDestination(value: unknown): string | null {
  if (typeof value !== "string" || unsafeText(value) || value.includes("#") || !value.startsWith("/") || value.startsWith("//")) return null;
  const route = parseStaffLocation(value);
  if (route.kind !== "dashboard" && route.kind !== "create-project" && route.kind !== "project" && route.kind !== "edit-project" && route.kind !== "admin" && route.kind !== "notices" && route.kind !== "notifications" && route.kind !== "notification-preferences") return null;
  const canonical = staffPathFor(route);
  return parseStaffLocation(canonical).kind === "not-found" ? null : canonical;
}
