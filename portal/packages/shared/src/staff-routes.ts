import {
  PRODUCTION_CALENDAR_LAYERS,
  PRODUCTION_CALENDAR_MAX_EDITOR_IDS,
  PRODUCTION_CALENDAR_MAX_ENCODED_QUERY_BYTES,
  PRODUCTION_CALENDAR_MAX_STAGE_KEYS,
  PRODUCTION_CALENDAR_SUBVIEWS,
  productionCalendarFiltersSchema,
} from "./production-calendar";
import { isSydneyCalendarDate } from "./sydney-civil-time";
import { STAGE_PRESENTATION_KEYS, type StagePresentationKey } from "./stage-move";

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

export type DashboardListKanbanRoute = {
  kind: "dashboard";
  dashboardView: "list" | "kanban";
};

export type DashboardCalendarFacetRoute = {
  kind: "dashboard";
  calendar: DashboardCalendarState;
};

export type DashboardRoute =
  | { kind: "dashboard" }
  | DashboardListKanbanRoute
  | DashboardCalendarFacetRoute;

export type StaffRoute =
  | DashboardRoute
  | { kind: "create-project" }
  | { kind: "project"; projectId: string; collaboration?: "open" }
  | { kind: "edit-project"; projectId: string }
  | { kind: "admin" }
  | { kind: "notifications" }
  | { kind: "not-found" }
  | { kind: "reserved" };

export const CANONICAL_LOWERCASE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID = CANONICAL_LOWERCASE_UUID_REGEX;
const reservedRoots = new Set(["api", "media", "__transform-source", "d"]);
const COLLABORATION_NOTIFICATION_TYPES = new Set(["mentioned", "subtask_assigned", "subtask_due_today", "project_collaboration_activity"]);
const calendarParameterNames = new Set([
  "view", "date", "sub", "layers", "editors", "unassigned", "stages", "completed", "delivered", "overdue", "mine", "q",
]);
const dashboardListKanbanParameterNames = new Set(["view"]);
const calendarFilterDefaults = productionCalendarFiltersSchema.parse({});

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

  const rawEditors = params.get("editors");
  const editorValues = rawEditors === null ? [] : parseCalendarList(rawEditors);
  if (editorValues === null || editorValues.length > PRODUCTION_CALENDAR_MAX_EDITOR_IDS || editorValues.some((value) => !UUID.test(value)) || new Set(editorValues).size !== editorValues.length) return null;

  const rawStages = params.get("stages");
  const stageValues = rawStages === null ? [] : parseCalendarList(rawStages);
  if (stageValues === null || stageValues.length > PRODUCTION_CALENDAR_MAX_STAGE_KEYS || stageValues.some((value) => !STAGE_PRESENTATION_KEYS.includes(value as StagePresentationKey)) || new Set(stageValues).size !== stageValues.length) return null;
  const stageKeys = canonicalKnownList(stageValues as StagePresentationKey[], STAGE_PRESENTATION_KEYS);

  const includeUnassigned = parseCalendarFlag(params, "unassigned");
  const showCompletedChecklist = parseCalendarFlag(params, "completed");
  const showDeliveredProjects = parseCalendarFlag(params, "delivered");
  const overdueOnly = parseCalendarFlag(params, "overdue");
  const myTasks = parseCalendarFlag(params, "mine");
  if (includeUnassigned === null || showCompletedChecklist === null || showDeliveredProjects === null || overdueOnly === null || myTasks === null) return null;

  const search = params.get("q") ?? "";
  if ([...search].length > 200) return null;

  return {
    view: "calendar",
    date,
    subview: subview as DashboardCalendarState["subview"],
    layers,
    editorIds: [...editorValues].sort(),
    includeUnassigned,
    stageKeys,
    showCompletedChecklist,
    showDeliveredProjects,
    overdueOnly,
    search,
    myTasks,
  };
}

function parseDashboardListKanbanLocation(params: URLSearchParams): DashboardListKanbanRoute | null {
  for (const name of params.keys()) {
    if (!dashboardListKanbanParameterNames.has(name)) return null;
  }
  const dashboardView = params.get("view");
  if (dashboardView !== "list" && dashboardView !== "kanban") return null;

  return { kind: "dashboard", dashboardView };
}

/** Parse the complete, canonical relative staff location. Queries stay closed except for
 * the one-shot collaboration arrival intent on an otherwise canonical project route. */
export function parseStaffLocation(location: string): StaffRoute {
  if (typeof location !== "string" || unsafeText(location) || location.includes("#")) return { kind: "not-found" };
  const question = location.indexOf("?");
  if (question === -1) return parseStaffPathname(location);
  const pathname = location.slice(0, question);
  const query = location.slice(question + 1);
  const route = parseStaffPathname(pathname);
  if (route.kind === "project" && query === "collaboration=open") return { ...route, collaboration: "open" };
  if (route.kind !== "dashboard" || pathname !== "/") return { kind: "not-found" };
  const params = parseDashboardQuery(query);
  if (params === null) return { kind: "not-found" };
  const view = params.get("view");
  if (view === "list" || view === "kanban") return parseDashboardListKanbanLocation(params) ?? { kind: "not-found" };
  if (view === "calendar") {
    const calendar = parseCalendarLocation(params);
    if (calendar === null) return { kind: "not-found" };
    return { kind: "dashboard", calendar };
  }
  return { kind: "not-found" };
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

function calendarPathFor(calendar: DashboardCalendarState): string {
  const params = new URLSearchParams();
  params.set("view", "calendar");
  params.set("date", calendar.date);
  params.set("sub", calendar.subview);
  params.set("layers", serializedList(calendar.layers, PRODUCTION_CALENDAR_LAYERS));
  if (calendar.editorIds.length > 0) params.set("editors", serializedList(calendar.editorIds, []));
  if (calendar.includeUnassigned !== calendarFilterDefaults.includeUnassigned) params.set("unassigned", "1");
  if (calendar.stageKeys.length > 0) params.set("stages", serializedList(calendar.stageKeys, STAGE_PRESENTATION_KEYS));
  if (calendar.showCompletedChecklist !== calendarFilterDefaults.showCompletedChecklist) params.set("completed", "1");
  if (calendar.showDeliveredProjects !== calendarFilterDefaults.showDeliveredProjects) params.set("delivered", "1");
  if (calendar.overdueOnly !== calendarFilterDefaults.overdueOnly) params.set("overdue", "1");
  if (calendar.myTasks !== calendarFilterDefaults.myTasks) params.set("mine", "1");
  const safeSearch = stripUnsafeText(calendar.search);
  if (safeSearch !== calendarFilterDefaults.search) params.set("q", safeSearch);
  return `/?${params.toString()}`;
}

export function staffPathFor(route: Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>): string {
  switch (route.kind) {
    case "dashboard": {
      if ("calendar" in route) return calendarPathFor(route.calendar);
      if ("dashboardView" in route) return `/?view=${route.dashboardView}`;
      return "/";
    }
    case "create-project": return "/projects/new";
    case "project": return `/projects/${encodeURIComponent(route.projectId)}${route.collaboration === "open" ? "?collaboration=open" : ""}`;
    case "edit-project": return `/projects/${encodeURIComponent(route.projectId)}/edit`;
    case "admin": return "/admin";
    case "notifications": return "/settings/notifications";
  }
}

/** The canonical staff-app destination for a project-scoped notification, or undefined if the
 * notification has no project (e.g. a notice-board mention). */
export function projectNotificationRoute(projectId: string | null, type: string): StaffRoute | undefined {
  if (!projectId) return undefined;
  return { kind: "project", projectId, ...(COLLABORATION_NOTIFICATION_TYPES.has(type) ? { collaboration: "open" as const } : {}) };
}

/** Only canonical, relative staff locations are valid OAuth return destinations. */
export function safeStaffDestination(value: unknown): string | null {
  if (typeof value !== "string" || unsafeText(value) || value.includes("#") || !value.startsWith("/") || value.startsWith("//")) return null;
  const route = parseStaffLocation(value);
  if (route.kind !== "dashboard" && route.kind !== "create-project" && route.kind !== "project" && route.kind !== "edit-project" && route.kind !== "admin" && route.kind !== "notifications") return null;
  const canonical = staffPathFor(route);
  return parseStaffLocation(canonical).kind === "not-found" ? null : canonical;
}
