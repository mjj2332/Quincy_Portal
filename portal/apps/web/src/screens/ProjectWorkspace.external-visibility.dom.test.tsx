/**
 * External-editor visibility inventory — the safety net for the #54 re-skin.
 *
 * The workspace cluster is the only project surface an external editor reaches, and roughly twenty
 * sites across it gate what that role may see. The existing DOM tests pin *behaviour* thoroughly,
 * but almost nothing pins the **inventory**: which controls and which data are on the page for a
 * given role. Four mentions of `external_editor` across the whole cluster's tests is not a fence
 * you can re-skin 27 files behind.
 *
 * So this file freezes the inventory itself, captured against the pre-migration implementation and
 * committed as a literal. After the re-skin the same render must produce the same inventory. A
 * control that appears for `external_editor`, or one that silently vanishes, fails here — which is
 * the one property #54 is least able to notice by eye and least able to afford getting wrong.
 *
 * ## Why an inventory and not a snapshot
 *
 * The inventory is built only from things a re-skin must not change: `data-testid` hooks, ARIA
 * roles, and accessible names. It deliberately records no class name, no element tag, no DOM
 * nesting and no styling — otherwise it would fail on every commit of the migration for reasons
 * that have nothing to do with visibility, and would be deleted or loosened within a day. #50
 * ("decouple the test seam from styling") established that seam; this file consumes it.
 *
 * Counts are recorded alongside each testid because "the delete button disappeared from four of
 * five rows" is a visibility change that a set-only inventory would miss.
 *
 * ## Both directions
 *
 * `admin` is captured beside `external_editor` for a reason. A guard that only checks the external
 * inventory catches a control that *vanishes* but not one that *leaks in*, because it has nothing
 * to compare against. Recording both, plus the explicit difference between them, makes a leak fail
 * as loudly as a disappearance.
 *
 * The explicit per-capability assertions at the bottom are not redundant with the frozen literals.
 * If a future change legitimately alters the page and someone re-freezes the literals, those
 * assertions still hold the line on the capability contract itself — they are written against
 * `EXTERNAL_EDITOR_CAPABILITIES`, not against today's DOM.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_EDITOR_CAPABILITIES, ROLE_CAPABILITIES, type Role } from "@quincy/shared";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { QuincyQueryProvider } from "../lib/query-client";

const authState = vi.hoisted(() => ({ role: "admin" }));
vi.mock("../lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "user-1", role: authState.role } }, isPending: false }),
}));

const apiGetMock = vi.fn<(path: string, init?: unknown) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiGet: (path: string, init?: unknown) => apiGetMock(path, init),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
    apiPatch: (path: string, body: unknown) => apiPatchMock(path, body),
    apiDelete: (path: string) => apiDeleteMock(path),
  };
});
vi.mock("../lib/confirm", () => ({ confirm: () => Promise.resolve(true) }));

// ---------------------------------------------------------------------------
// Fixtures — deliberately rich enough that every gated control has data to render against. An
// empty project would produce an empty inventory that passes for both roles and proves nothing.
// ---------------------------------------------------------------------------

function workspaceAsset(id: string, overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return {
    id, section: null, collectionId: "collection", kind: "photo", originalFilename: `${id}.jpg`,
    bytes: 1, width: null, height: null, ratingFromMetadata: null, renditionStatus: "ready",
    createdAt: "2026-07-21T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null,
    supersedesAssetId: null, review: null, selected: false, ...overrides,
  };
}

/**
 * Ids are real UUIDs because the external DTO schemas in `@quincy/shared` are `.strict()` and
 * validate them. That strictness is the point: an external editor's detail response is parsed by
 * `externalProjectDetailToWorkspace`, so a fixture shaped like the *internal* response is rejected
 * and the workspace renders nothing. An empty external inventory would sail past a naive
 * "external sees less than admin" assertion, which is why the first test below refuses to accept
 * an empty render from either role.
 */
const PROJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COLLECTION_IDS = {
  raw: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  edited: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  video: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  floorplan: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  copy: "ffffffff-ffff-4fff-8fff-ffffffffffff",
} as const;

const RAW_ONE = "11111111-1111-4111-8111-111111111111";
const RAW_TWO = "22222222-2222-4222-8222-222222222222";
const EDITED_ONE = "44444444-4444-4444-8444-444444444444";

const service = (kind: keyof typeof COLLECTION_IDS, receivedCount: number) => ({
  id: COLLECTION_IDS[kind], kind, status: receivedCount ? "received" : "empty",
  expectedCount: null, receivedCount,
});

const COLLECTIONS = [service("raw", 2), service("edited", 1), service("video", 0), service("floorplan", 0), service("copy", 0)];

/** The external wire contract — parsed by `externalProjectDetailSchema`. */
function externalDetailFixture() {
  return {
    id: PROJECT_ID,
    address: { street: "12 Example St", suburb: "Suburbia", postcode: "2000" },
    agencyDisplayName: null, agentDisplayName: null, shootDate: null, timeWindow: null,
    stageKey: "raw_review", boardRevision: 0, deadline: null, productionNotes: null,
    services: COLLECTIONS, cover: null, contractEnabled: true, editedUploadAvailable: true,
    collections: COLLECTIONS, members: [], editorFolderAttention: null,
  };
}

/** The internal shape, for every staff role. */
function internalDetailFixture() {
  return {
    id: PROJECT_ID, street: "12 Example St", suburb: "Suburbia", postcode: "2000",
    agencyName: "Example Agency", agentName: "Alex Agent", shootDate: "2026-07-20",
    stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null,
    coverAssetId: null, effectiveCoverAssetId: null, archivedAt: null, contractEnabled: true,
    // Must match `externalDetailFixture`. Omitting it suppressed the admin's edited dropzone and
    // made the external editor look like it could upload where an admin could not — a fixture
    // artefact that the "strictly less than admin" test caught before the literals were frozen.
    editedUploadAvailable: true,
    collections: COLLECTIONS, members: [],
    deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false },
  };
}

function installApiMocks() {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  apiDeleteMock.mockReset();
  apiGetMock.mockImplementation((path: string) => {
    const external = authState.role === "external_editor";
    if (path === `/api/projects/${PROJECT_ID}`) return Promise.resolve(external ? externalDetailFixture() : internalDetailFixture());
    if (path.includes("/ingest-status")) return Promise.resolve({ expectedCount: null, receivedCount: 2, mismatch: false });
    if (path.includes("/assets?collection=raw")) {
      return Promise.resolve({ assets: [
        workspaceAsset(RAW_ONE, { collectionId: COLLECTION_IDS.raw, originalFilename: "raw-1.jpg" }),
        workspaceAsset(RAW_TWO, { collectionId: COLLECTION_IDS.raw, originalFilename: "raw-2.jpg" }),
      ] });
    }
    if (path.includes("/assets?collection=edited")) {
      return Promise.resolve({ assets: [workspaceAsset(EDITED_ONE, { collectionId: COLLECTION_IDS.edited, originalFilename: "edited-1.jpg" })] });
    }
    if (path.includes("/assets?collection=")) return Promise.resolve({ assets: [] });
    if (path.includes("/links")) return Promise.resolve({ links: [] });
    if (path.includes("/annotations")) return Promise.resolve({ annotations: [] });
    if (path.includes("/comments?")) return Promise.resolve({ project: { id: PROJECT_ID, street: "12 Example St" }, comments: [] });
    if (path.includes("comment-read-marker")) return Promise.resolve({ projectId: PROJECT_ID, marker: null, latest: null, unreadCount: 0 });
    if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [] });
    if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
    if (path.includes("/activity")) return Promise.resolve({ events: [], nextCursor: null });
    if (path.includes("/collaboration-summary")) return Promise.resolve({ project: { id: PROJECT_ID, street: "12 Example St", stageKey: "raw_review" }, members: [] });
    if (path === "/api/stages") return Promise.resolve({ stages: [] });
    if (path.includes("/jobs")) return Promise.resolve({ jobs: [] });
    return Promise.resolve({});
  });
}

// ---------------------------------------------------------------------------
// Mount harness — same shape as ProjectWorkspace.dom.test.tsx.
// ---------------------------------------------------------------------------

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(
      <QuincyQueryProvider key={`${authState.role}:visibility`} principalId="test-user" role={authState.role as Role}>
        {value}
      </QuincyQueryProvider>,
    );
    await Promise.resolve();
  });
}

async function unmount() {
  if (!root) return;
  await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
}

async function flush(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  }
}

// ---------------------------------------------------------------------------
// The inventory — testids with counts, ARIA roles, and accessible names of interactive elements.
// Nothing here reads a class, a tag or a nesting relationship.
// ---------------------------------------------------------------------------

interface Inventory {
  testids: Record<string, number>;
  roles: string[];
  controls: string[];
}

function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label) return label.trim();
  const title = el.getAttribute("title");
  if (title) return title.trim();
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return `[placeholder] ${placeholder.trim()}`;
  const type = el.getAttribute("type");
  return type ? `[${el.tagName.toLowerCase()}:${type}]` : `[${el.tagName.toLowerCase()}]`;
}

function inventoryOf(host: HTMLElement): Inventory {
  const testids: Record<string, number> = {};
  for (const el of host.querySelectorAll<HTMLElement>("[data-testid]")) {
    const id = el.dataset.testid as string;
    testids[id] = (testids[id] ?? 0) + 1;
  }

  const roles = [...new Set([...host.querySelectorAll("[role]")].map((el) => el.getAttribute("role") as string))].sort();

  const controls = [...new Set(
    [...host.querySelectorAll("button, a[href], input, select, textarea, [contenteditable='true']")].map(accessibleName),
  )].sort();

  return { testids: Object.fromEntries(Object.entries(testids).sort(([a], [b]) => a.localeCompare(b))), roles, controls };
}

const TABS = ["RAW", "Edited", "Video", "Floorplan", "Copy"] as const;
type TabName = (typeof TABS)[number];
type TabInventories = Record<TabName, Inventory>;

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function tabButton(host: HTMLElement, name: TabName): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')]
    .find((item) => item.textContent?.startsWith(name));
  if (!button) throw new Error(`No "${name}" tab button — the tab strip itself changed, which is a visibility change.`);
  return button;
}

/**
 * Renders the workspace as `role` and captures the inventory of **every collection tab**, not just
 * the default one.
 *
 * Capturing only the landing tab would be a hole big enough to drive the ticket through: an
 * external editor's upload and review controls (`uploadEdited`, `reviewEdited`, `uploadExtras`)
 * live on Edited, Video, Floorplan and Copy, and the acceptance criteria call out file upload and
 * review behaviour by name. A RAW-only inventory would have declared those surfaces unchanged
 * without ever having rendered them.
 *
 * `DUMP_VISIBILITY_INVENTORY=1` writes the captures to `/tmp` instead of asserting — that is how
 * the frozen literals below were generated from the pre-migration implementation. Kept so a future
 * re-freeze is a reproducible act rather than a hand-edit.
 */
async function inventoriesForRole(role: Role): Promise<TabInventories> {
  authState.role = role;
  installApiMocks();
  const host = mount();
  await render(<ProjectWorkspace projectId={PROJECT_ID} />);
  await flush();

  const captured = {} as TabInventories;
  for (const tab of TABS) {
    if (tab !== "RAW") {
      await click(tabButton(host, tab));
      await flush();
    }
    captured[tab] = inventoryOf(host);
  }

  if (process.env.DUMP_VISIBILITY_INVENTORY) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`/tmp/inventory-${role}.json`, JSON.stringify(captured, null, 2));
  }
  await unmount();
  host.remove();
  return captured;
}

describe("external-editor visibility inventory", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(async () => { await unmount(); document.body.innerHTML = ""; });

  it("captures a non-trivial inventory on every tab for both roles, so an empty render cannot pass vacuously", async () => {
    const external = await inventoriesForRole("external_editor");
    const admin = await inventoriesForRole("admin");

    for (const tab of TABS) {
      expect(Object.keys(external[tab].testids).length, `external_editor / ${tab}`).toBeGreaterThan(0);
      expect(external[tab].controls.length, `external_editor / ${tab}`).toBeGreaterThan(0);
      expect(Object.keys(admin[tab].testids).length, `admin / ${tab}`).toBeGreaterThan(0);
      expect(admin[tab].controls.length, `admin / ${tab}`).toBeGreaterThan(0);
    }
  });

  it("shows an external editor strictly less than an admin on every tab, and never anything an admin lacks", async () => {
    const external = await inventoriesForRole("external_editor");
    const admin = await inventoriesForRole("admin");

    for (const tab of TABS) {
      const adminTestids = new Set(Object.keys(admin[tab].testids));
      const leaked = Object.keys(external[tab].testids).filter((id) => !adminTestids.has(id));
      expect(leaked, `${tab}: testids present for external_editor but absent for admin: ${leaked.join(", ")}`).toEqual([]);

      const adminControls = new Set(admin[tab].controls);
      const leakedControls = external[tab].controls.filter((name) => !adminControls.has(name));
      expect(leakedControls, `${tab}: controls present for external_editor but absent for admin: ${leakedControls.join(", ")}`).toEqual([]);
    }
  });

  it("matches the inventory frozen against the pre-migration implementation", async () => {
    const external = await inventoriesForRole("external_editor");
    expect(external).toEqual(FROZEN_EXTERNAL_EDITOR);
  });

  it("matches the admin inventory frozen against the pre-migration implementation", async () => {
    const admin = await inventoriesForRole("admin");
    expect(admin).toEqual(FROZEN_ADMIN);
  });

  it("the capability contract itself is unchanged", () => {
    // Written against the shared source of truth, not the DOM, so it still holds the line if the
    // frozen inventories below are ever legitimately re-captured.
    expect([...EXTERNAL_EDITOR_CAPABILITIES].sort()).toEqual([
      "annotateEdited", "annotateRaw", "collaborateOnProject", "compareFrames", "moveProjectStage",
      "recommendRaw", "reviewEdited", "uploadEdited", "uploadExtras", "viewEdited",
      "viewProductionCalendar", "viewRaw",
    ]);
    for (const forbidden of ["adminBackend", "editProject", "uploadRaw", "selectForEditing", "viewNoticeBoard"]) {
      expect(ROLE_CAPABILITIES.external_editor as readonly string[]).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Frozen inventories — captured from the pre-migration implementation at the #54 branch point.
// Regenerate ONLY with DUMP_VISIBILITY_INVENTORY=1, and only when a change to what a role may see
// is intended and reviewed. Re-freezing these to turn a red build green is exactly the failure
// this file exists to prevent.
//
// Re-frozen once, deliberately, for #110: every `testids` map below gained a `"toast-viewport": 1`
// entry. #110 mounts a single always-present `ToastViewport` in every `ProjectWorkspace` view
// state; before it, the toast container was conditional (only `full-workspace`, plus a separate one
// inside `UnavailableProject`) and carried no `data-testid` at all. The new id appears exactly once
// per tab, identically for `external_editor` and `admin`, so it changes neither role's relative
// visibility nor the leak/disappearance checks this file exists to enforce — see #110's build
// report for the verification. Nothing else in either literal moved.
//
// Re-frozen again for #203: every `controls` list below gained one `"[input]"` entry per tab.
// #203 replaces the Stage control's native `<select>` with the ReUI `Select` (Base UI
// `@base-ui/react/select`), whose `Select.Root` always renders one visually-hidden `<input>`
// (for form submission) as a sibling of the trigger/content, regardless of `name`. That element
// has no accessible name and no `type`, so `accessibleName` renders it as `"[input]"` — additive,
// present once per tab for both roles alike, and changes neither role's relative visibility.
// Nothing else in either literal moved.
//
// Re-frozen again, deliberately, for #204 (2026-09-18): `ProjectTeamControl` (per-role "+ Add"
// popovers, "Add Editor" / "Add Photographer" buttons) was replaced by `ProjectTeamCombobox`, one
// Base UI multi-select combobox with a single chips input. `FROZEN_ADMIN`'s five `controls`
// arrays lose "Add Editor" and "Add Photographer" and gain "Add team member" (the chips input's
// accessible name) in their place. Base UI's Combobox also renders an `aria-hidden` mirror
// `<input>`, but `controls` is a de-duplicated set and #203's Select already contributes the
// same `"[input]"` entry, so the literal gains nothing for it. Re-captured with
// DUMP_VISIBILITY_INVENTORY on the tree rebased over #203, not hand-merged. Nothing else moved:
// the `project-team-control` testid, its count, and every `roles` entry are unchanged, and
// `FROZEN_EXTERNAL_EDITOR` needs no edit at all — an external editor never gets `canEdit` on the
// Team section, so it never rendered the old buttons and never renders the new combobox either.
//
// Re-frozen again, deliberately, for #205: the Deadline block and the whole Dropbox `<section>`
// in `ProjectHeader.tsx` moved behind two dashed trigger buttons (`ProjectHeaderDeadline.tsx`,
// `ProjectHeaderDropbox.tsx`) that open a `reui/popover.tsx` popover — closed by default, and
// unmounted (not `keepMounted`) while closed, same as `quincy/NotificationBell.tsx`'s panel. Both
// literals below lose `project-deadline-row` (`ProjectDeadlineControl.tsx`'s two rail rows, always
// mounted before #205) and gain `project-deadline-trigger` in its place, on every tab, for both
// roles — the trigger renders unconditionally in the Production section exactly where
// `ProjectDeadlineControl` used to. The admin literal additionally loses `dropbox-sync` and gains
// `project-dropbox-trigger`, again on every tab, since only admin's fixture clears the Dropbox
// gate (`canUpload && (hasRawFolder || canAdminBackend || monitoredRawFolder)`) in this file's
// fixtures — external_editor has no `uploadRaw` capability, so it never rendered a Dropbox trigger
// either, matching its pre-#205 absence of `dropbox-sync`. The controls list gains one new
// accessible name per role: both roles gain `"Deadline: Not set"` (the trigger's own `aria-label`,
// since neither fixture sets a deadline); admin additionally gains `"Dropbox: Not monitored"`
// (neither fixture sets `monitoredRawFolder` nor `autohdrBlocked`). Both losses are exactly the
// mirror of the previous inline controls' own accessible names, `"Set Deadline"` and `"Sync from
// Dropbox"` — a click target replaced by a different click target, not an admin-only capability
// quietly disappearing (`ProjectWorkspace.dom.test.tsx`'s own Deadline/Dropbox tests exercise
// opening each trigger and asserting its content, unchanged in substance). Nothing else in either
// literal moved.
// ---------------------------------------------------------------------------

const FROZEN_EXTERNAL_EDITOR = {
  "RAW": {
    "testids": {
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "photo-grid-filter": 5,
      "photo-grid-tile": 2,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "button",
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "All2",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Copy0",
      "Deadline: Not set",
      "Discussion",
      "Edited1",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Labeled0",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Rated0",
      "Recommend",
      "Recommended0",
      "Redo",
      "Select all",
      "Select raw-1.jpg",
      "Select raw-2.jpg",
      "Strikethrough",
      "Underline",
      "Undo",
      "Video0",
      "[div]",
      "[input]",
      "\u2190 Dashboard"
    ]
  },
  "Edited": {
    "testids": {
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "photo-grid-filter": 4,
      "photo-grid-tile": 1,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "button",
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "All1",
      "Approve",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Choose files",
      "Copy0",
      "Deadline: Not set",
      "Discussion",
      "Edited1",
      "Flag",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Labeled0",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Rated0",
      "Redo",
      "Select all",
      "Select edited-1.jpg",
      "Strikethrough",
      "Underline",
      "Undo",
      "Video0",
      "[div]",
      "[input:file]",
      "[input]",
      "\u2190 Dashboard"
    ]
  },
  "Video": {
    "testids": {
      "collection-link-add": 1,
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "Add link",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Copy0",
      "Deadline: Not set",
      "Discussion",
      "Edited1",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Redo",
      "Strikethrough",
      "Underline",
      "Undo",
      "Video0",
      "[div]",
      "[input]",
      "[placeholder] Final walkthrough",
      "[placeholder] https://vimeo.com/\u2026",
      "\u2190 Dashboard"
    ]
  },
  "Floorplan": {
    "testids": {
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Copy0",
      "Deadline: Not set",
      "Discussion",
      "Edited1",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Redo",
      "Strikethrough",
      "Underline",
      "Undo",
      "Upload floorplan",
      "Video0",
      "[div]",
      "[input:file]",
      "[input]",
      "\u2190 Dashboard"
    ]
  },
  "Copy": {
    "testids": {
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Copy0",
      "Deadline: Not set",
      "Discussion",
      "Edited1",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Redo",
      "Strikethrough",
      "Underline",
      "Undo",
      "Upload copy",
      "Video0",
      "[div]",
      "[input:file]",
      "[input]",
      "\u2190 Dashboard"
    ]
  }
} as const satisfies TabInventories;

const FROZEN_ADMIN = {
  "RAW": {
    "testids": {
      "autohdr-handoff": 1,
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "photo-grid-filter": 6,
      "photo-grid-tile": 2,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-dropbox-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "button",
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "Add team member",
      "All2",
      "Approve",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Choose files",
      "Copy0",
      "Deadline: Not set",
      "Delete raw-1.jpg",
      "Delete raw-2.jpg",
      "Discussion",
      "Download 0 selected (zip)",
      "Dropbox: Not monitored",
      "Edit details",
      "Edited1",
      "Flag",
      "Floorplan0",
      "For editing0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Labeled0",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Rated0",
      "Recommend",
      "Recommended0",
      "Redo",
      "Select all",
      "Select for editing",
      "Select raw-1.jpg",
      "Select raw-2.jpg",
      "Send 0 selected to AutoHDR",
      "Strikethrough",
      "Underline",
      "Undo",
      "Use as project cover",
      "Video0",
      "[div]",
      "[input:file]",
      "[input]",
      "\u2190 Dashboard"
    ]
  },
  "Edited": {
    "testids": {
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "photo-grid-filter": 4,
      "photo-grid-tile": 1,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-dropbox-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "button",
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "Add team member",
      "All1",
      "Approve",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Choose files",
      "Copy0",
      "Deadline: Not set",
      "Delete edited-1.jpg",
      "Discussion",
      "Dropbox: Not monitored",
      "Edit details",
      "Edited1",
      "Flag",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Labeled0",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Rated0",
      "Redo",
      "Select all",
      "Select edited-1.jpg",
      "Strikethrough",
      "Underline",
      "Undo",
      "Use as project cover",
      "Video0",
      "[div]",
      "[input:file]",
      "[input]",
      "\u2190 Dashboard"
    ]
  },
  "Video": {
    "testids": {
      "collection-link-add": 1,
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-dropbox-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "Add link",
      "Add team member",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Copy0",
      "Deadline: Not set",
      "Discussion",
      "Dropbox: Not monitored",
      "Edit details",
      "Edited1",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Redo",
      "Strikethrough",
      "Underline",
      "Undo",
      "Video0",
      "[div]",
      "[input]",
      "[placeholder] Final walkthrough",
      "[placeholder] https://vimeo.com/\u2026",
      "\u2190 Dashboard"
    ]
  },
  "Floorplan": {
    "testids": {
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-dropbox-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "Add team member",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Copy0",
      "Deadline: Not set",
      "Discussion",
      "Dropbox: Not monitored",
      "Edit details",
      "Edited1",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Redo",
      "Strikethrough",
      "Underline",
      "Undo",
      "Upload floorplan",
      "Video0",
      "[div]",
      "[input:file]",
      "[input]",
      "\u2190 Dashboard"
    ]
  },
  "Copy": {
    "testids": {
      "discussion-comments": 1,
      "discussion-composer": 1,
      "discussion-read-anchor": 1,
      "project-collaboration-head": 1,
      "project-collaboration-panel": 1,
      "project-collaboration-scroll": 1,
      "project-collaboration-toggle": 1,
      "project-collaboration-wrap": 1,
      "project-deadline-trigger": 1,
      "project-dropbox-trigger": 1,
      "project-header": 1,
      "project-overview-tab": 5,
      "project-team-control": 1,
      "project-workspace": 1,
      "toast-viewport": 1,
      "workspace-main": 1
    },
    "roles": [
      "combobox",
      "status",
      "tab",
      "tablist",
      "tabpanel",
      "toolbar"
    ],
    "controls": [
      "+ Add an item",
      "Activity",
      "Add team member",
      "Bold",
      "Bullet list",
      "Checklist",
      "Checklist0 of 0 complete \u00b7 0%\u2212",
      "Copy0",
      "Deadline: Not set",
      "Discussion",
      "Dropbox: Not monitored",
      "Edit details",
      "Edited1",
      "Floorplan0",
      "Heading",
      "Hide collaboration",
      "Hide \u203a",
      "Italic",
      "Link",
      "Move project Stage",
      "Ordered list",
      "Post comment",
      "RAW2",
      "Redo",
      "Strikethrough",
      "Underline",
      "Undo",
      "Upload copy",
      "Video0",
      "[div]",
      "[input:file]",
      "[input]",
      "\u2190 Dashboard"
    ]
  }
} as const satisfies TabInventories;
