/**
 * The small, deliberately closed URL contract for the authenticated staff SPA.
 * UUID casing is a parser convention: IDs generated and stored by this app are
 * lowercase, while the API's general UUID validator intentionally accepts more.
 */
export type StaffRoute =
  | { kind: "dashboard" }
  | { kind: "create-project" }
  | { kind: "project"; projectId: string; collaboration?: "open" }
  | { kind: "edit-project"; projectId: string }
  | { kind: "admin" }
  | { kind: "not-found" }
  | { kind: "reserved" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reservedRoots = new Set(["api", "media", "__transform-source", "d"]);
const COLLABORATION_NOTIFICATION_TYPES = new Set(["mentioned", "subtask_assigned", "subtask_due_today"]);

function unsafeText(value: string): boolean {
  return /[\\\u0000-\u001f\u007f]/.test(value);
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
  if (segments[0] !== "projects") return { kind: "not-found" };
  if (segments.length === 2 && segments[1] === "new") return { kind: "create-project" };
  if (!UUID.test(segments[1] ?? "")) return { kind: "not-found" };
  if (segments.length === 2) return { kind: "project", projectId: segments[1]! };
  if (segments.length === 3 && segments[2] === "edit") return { kind: "edit-project", projectId: segments[1]! };
  return { kind: "not-found" };
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
  if (route.kind !== "project" || query !== "collaboration=open") return { kind: "not-found" };
  return { ...route, collaboration: "open" };
}

export function staffPathFor(route: Exclude<StaffRoute, { kind: "not-found" } | { kind: "reserved" }>): string {
  switch (route.kind) {
    case "dashboard": return "/";
    case "create-project": return "/projects/new";
    case "project": return `/projects/${encodeURIComponent(route.projectId)}${route.collaboration === "open" ? "?collaboration=open" : ""}`;
    case "edit-project": return `/projects/${encodeURIComponent(route.projectId)}/edit`;
    case "admin": return "/admin";
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
  return route.kind === "dashboard" || route.kind === "create-project" || route.kind === "project" || route.kind === "edit-project" || route.kind === "admin"
    ? staffPathFor(route)
    : null;
}
