import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_TYPES, type NotificationType, type Role } from "@quincy/shared";

/**
 * #337, whole app: a click on each Notification type opens the Workspace tab it is about.
 *
 * Everything between the bell and the tab is real — `App`, the shell router, the rail's
 * `NotificationBell` and `NotificationList` rows, `InternalLink`/`locationStore`, the route's
 * one-shot arrival intent, the real `QuincyQueryProvider` and the real `ProjectWorkspace`. Only
 * the session and the HTTP boundary (`lib/api`'s `apiGet`/`apiPost`/`apiDelete`) are stubbed.
 *
 * `it.each(NOTIFICATION_TYPES)` enrols a new type automatically. The expected tab is written out
 * from the issue's table rather than read from `NOTIFICATION_WORKSPACE_TAB`, so the map cannot
 * grade itself; a new type with no row here fails the lookup below.
 */

const PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000";

const EXPECTED_TAB: Record<NotificationType, "RAW" | "Edited" | "Collaboration"> = {
  raw_ready: "RAW",
  sent_to_editing: "RAW",
  autohdr_stalled: "RAW",
  edited_landed: "Edited",
  delivered: "Edited",
  comment_added: "Collaboration",
  assigned_to_project: "Collaboration",
  mentioned: "Collaboration",
  subtask_assigned: "Collaboration",
  subtask_due_today: "Collaboration",
  project_deadline_reminder: "Collaboration",
  project_activity: "Collaboration",
  project_collaboration_activity: "Collaboration",
};

const sessionState = vi.hoisted(() => ({ role: "admin" }));
vi.mock("./lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "u1", name: "Ada Lovelace", role: sessionState.role, authorizationEpoch: 0 } }, isPending: false, refetch: async () => undefined }),
  stopImpersonating: async () => undefined,
  consumeSignInDestination: () => null,
  signOut: async () => undefined,
}));

const notificationType = vi.hoisted(() => ({ value: "raw_ready" as string }));
const apiGetMock = vi.hoisted(() => vi.fn<(path: string, init?: unknown) => Promise<unknown>>());
vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
  return {
    ...actual,
    apiGet: (path: string, init?: unknown) => apiGetMock(path, init),
    apiPost: async () => ({ ok: true }),
    apiPatch: async () => ({ ok: true }),
    apiDelete: async () => ({ ok: true }),
  };
});

function projectFixture() {
  return {
    id: PROJECT_ID, street: "12 Example St", suburb: "Suburbia", postcode: "2000",
    agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review",
    rawFolderPath: null, rawFolderLink: null, coverAssetId: null, effectiveCoverAssetId: null,
    collections: [
      { id: "c-raw", kind: "raw", status: "active", expectedCount: null, receivedCount: 1 },
      { id: "c-edited", kind: "edited", status: "active", expectedCount: null, receivedCount: 1 },
    ],
    members: [],
    deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
  };
}

function asset(id: string) {
  return { id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready", createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false };
}

function serveApi(path: string): Promise<unknown> {
  if (path.startsWith("/api/notifications")) {
    return Promise.resolve({
      notifications: [{
        id: "n-1", projectId: PROJECT_ID, type: notificationType.value, title: "Project notification", body: null, readAt: null,
        createdAt: "2026-09-28T00:00:00.000Z", projectStreet: "12 Example St", coverAssetId: null, actor: null, subject: null, assetId: null,
      }],
      unreadCount: 1,
    });
  }
  if (path === "/api/project-access-snapshot") {
    return Promise.resolve({ principal: { id: "u1", role: sessionState.role, authorizationEpoch: 0 }, authorizationFingerprint: "f", projects: [{ projectId: PROJECT_ID, membershipCycleIds: [] }] });
  }
  if (path === `/api/projects/${PROJECT_ID}`) return Promise.resolve(projectFixture());
  if (path.includes("/assets?collection=raw")) return Promise.resolve({ assets: [asset("raw-1")] });
  if (path.includes("/assets?collection=edited")) return Promise.resolve({ assets: [asset("edited-1")] });
  if (path.includes("ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 1, mismatch: false });
  if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: PROJECT_ID, marker: null, latest: null, unreadCount: 0 });
  if (path.includes("comments")) return Promise.resolve({ project: { id: PROJECT_ID, street: "12 Example St" }, comments: [] });
  if (path.includes("annotations")) return Promise.resolve({ annotations: [] });
  if (path.includes("subtasks")) return Promise.resolve({ subtasks: [] });
  if (path.includes("mentionable-users")) return Promise.resolve({ users: [] });
  if (path.includes("/links")) return Promise.resolve({ links: [] });
  return Promise.resolve({});
}

import App from "./App";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  sessionState.role = "admin";
  apiGetMock.mockReset().mockImplementation(serveApi);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

async function flushUntil(predicate: () => boolean, label: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    if (predicate()) break;
    if (Date.now() > deadline) throw new Error(`flushUntil timed out after ${timeoutMs}ms waiting for: ${label} [at ${currentLocation()}, selected ${JSON.stringify(selectedTabNames())}]`);
  }
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

/** A native `.click()` — Base UI reacts to the terminal click of a press-release pair. */
async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
}

const workspaceTabs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')];
const workspaceTab = (name: string) => workspaceTabs().find((item) => item.textContent?.trim().startsWith(name));
const selectedTabNames = () => workspaceTabs().filter((item) => item.getAttribute("aria-selected") === "true").map((item) => item.textContent?.trim().replace(/[0-9—]+$/, ""));
const currentLocation = () => `${window.location.pathname}${window.location.search}`;
// #367: the URL keeps naming the shown tab after an arrival (the bare-URL strip is retired).
const tabLocation = (tab: string) => `/projects/${PROJECT_ID}${tab === "Collaboration" ? "?collaboration=open" : `?tab=${tab.toLowerCase()}`}`;

async function openProject() {
  window.history.replaceState(null, "", `/projects/${PROJECT_ID}`);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); await Promise.resolve(); });
  await flushUntil(() => workspaceTab("Collaboration") !== undefined && workspaceTab("RAW") !== undefined, "the Project workspace tabs");
}

async function clickNotification() {
  const trigger = document.querySelector<HTMLButtonElement>('[data-testid="rail-notification-trigger"]');
  if (!trigger) throw new Error("No notification bell in the rail");
  await flushUntil(() => trigger.getAttribute("aria-label") !== "Notifications", "the bell's unread count");
  await click(trigger);
  await flushUntil(() => document.querySelector(`[role="dialog"] a[href^="/projects/${PROJECT_ID}"]`) !== null, "the notification row link");
  // A pointer click (`detail: 1`), as a person makes. (Since #366 `InternalLink` intercepts a
  // `detail: 0` keyboard click too; `detail: 1` is realism here, not a requirement.)
  const row = document.querySelector<HTMLAnchorElement>(`[role="dialog"] a[href^="/projects/${PROJECT_ID}"]`)!;
  await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })); await Promise.resolve(); await Promise.resolve(); });
}

describe("#337: a Notification click opens the Workspace tab it is about", () => {
  it.each(NOTIFICATION_TYPES)("%s", async (type) => {
    const expected = EXPECTED_TAB[type];
    if (!expected) throw new Error(`No expected Workspace tab written for notification type ${type}`);
    notificationType.value = type;
    await openProject();
    // Start somewhere else, so the tab the click lands on can only have come from the arrival.
    const start = expected === "Collaboration" ? "RAW" : "Collaboration";
    await click(workspaceTab(start)!);
    await flushUntil(() => selectedTabNames()[0] === start, `the ${start} tab selected before the click`);

    await clickNotification();
    await flushUntil(() => selectedTabNames()[0] === expected && currentLocation() === tabLocation(expected), `${type} → ${expected}, acknowledged`);

    expect(selectedTabNames()).toEqual([expected]);
    // Focus-on-arrival is proven at the seam that owns it (ProjectWorkspace.dom.test.tsx, "#337
    // Workspace-tab arrival"). Through the bell it is currently taken back by the popover's default
    // `finalFocus` (return to the trigger) as the panel closes -- pre-existing, and parked for a
    // decision: see the #337 build notes.
    // Consumed once: the URL keeps naming the tab it landed on (#367)...
    expect(currentLocation()).toBe(tabLocation(expected));
    // ...and later in-Project navigation is not overridden by it.
    const next = expected === "RAW" ? "Collaboration" : "RAW";
    await click(workspaceTab(next)!);
    await flushUntil(() => selectedTabNames()[0] === next, `a later move to ${next}`);
    expect(selectedTabNames()).toEqual([next]);
  });

  it("lands a Photographer's Edited notification on Collaboration, where Edited is not offered", async () => {
    sessionState.role = "photographer" satisfies Role;
    notificationType.value = "edited_landed";
    await openProject();
    expect(workspaceTab("Edited")).toBeUndefined();
    await click(workspaceTab("RAW")!);
    await flushUntil(() => selectedTabNames()[0] === "RAW", "the RAW tab selected before the click");

    await clickNotification();
    await flushUntil(() => selectedTabNames()[0] === "Collaboration" && currentLocation() === tabLocation("Collaboration"), "edited_landed → Collaboration fallback");

    expect(selectedTabNames()).toEqual(["Collaboration"]);
  });
});
