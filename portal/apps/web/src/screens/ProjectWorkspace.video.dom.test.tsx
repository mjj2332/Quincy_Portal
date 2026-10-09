import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@quincy/shared";
import { ProjectWorkspace } from "./ProjectWorkspace";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { QuincyQueryProvider } from "../lib/query-client";
import { stubRailMedia } from "../testing/rail-media";

// jsdom has no matchMedia: without it the checklist reads as stacked (collapsed) (#377).
stubRailMedia(true);

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
    agencyDisplayName: null, agentDisplayName: null, shootDate: "2026-07-20", timeWindow: null,
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
    if (path.endsWith("/video-review")) return Promise.resolve({ open: false, parts: [] });
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
    if (path.includes("/subtasks")) return Promise.resolve({ subtasks: [], projectDefaultRange: { start: { localCivil: "2026-09-01T09:00", fold: 0 }, end: { localCivil: "2026-09-01T17:00", fold: 0 } } });
    if (path.includes("/mentionable-users")) return Promise.resolve({ users: [] });
    if (path.includes("/activity")) return Promise.resolve({ events: [], nextCursor: null });
    if (path.includes("/collaboration-summary")) return Promise.resolve({ project: { id: PROJECT_ID, street: "12 Example St", stageKey: "raw_review", archived: false }, members: [] });
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

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); await Promise.resolve(); });
}
function tabButton(host: HTMLElement, name: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="project-overview-tab"]')].find((item) => item.textContent?.startsWith(name));
  if (!button) throw new Error(`No "${name}" tab button`);
  return button;
}

const person = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
const ASSET = "77777777-7777-4777-8777-777777777777";
const version = { assetId: ASSET, version: 2, current: true, uploadedBy: person, createdAt: "2026-10-09T01:00:00.000Z", originalFilename: "film.mp4", bytes: 100, fps: { num: 30000, den: 1001 }, frameCount: 300, durationMs: 62000, width: 1080, height: 1920, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 30, tcDropFrame: true, fastStart: true, hasAudio: false, hasPoster: false, streamUrl: `/media/video/${ASSET}`, posterUrl: null };
const video = { id: "88888888-8888-4888-8888-888888888888", title: "Main walkthrough", premium: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: ASSET, uploading: null, versions: [version, { ...version, assetId: "66666666-6666-4666-8666-666666666666", version: 1, current: false }] };

let review: { open: boolean; parts: string[] } = { open: false, parts: [] };
function install() {
  installApiMocks();
  const base = apiGetMock.getMockImplementation()!;
  apiGetMock.mockImplementation((path: string, init?: unknown) => {
    if (path.endsWith("/video-review")) return Promise.resolve(review);
    if (path.endsWith("/videos")) return Promise.resolve({ videos: [video] });
    return base(path, init);
  });
}
async function openVideo(role: Role) {
  authState.role = role;
  install();
  const host = mount();
  await render(<ProjectWorkspace projectId={PROJECT_ID} />);
  await flush();
  await click(tabButton(host, "Video"));
  await flush();
  return host;
}
const paths = () => apiGetMock.mock.calls.map(([path]) => path);

describe("Video tab mount (#741 4d-i)", () => {
  beforeEach(() => { document.body.innerHTML = ""; vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 7, 1)); });
  afterEach(async () => { vi.restoreAllMocks(); await unmount(); document.body.innerHTML = ""; });

  it("gate closed: today's Video tab, no Films section and no /videos request", async () => {
    review = { open: false, parts: [] };
    const host = await openVideo("admin");
    expect(host.textContent).toContain("Video links");
    expect(host.querySelector('[data-testid="video-films"]')).toBeNull();
    expect(paths().some((path) => path.endsWith("/videos"))).toBe(false);
  });

  it("gate open: Films first, link tiles under a secondary heading, and neither the video assets query nor the RAW fetch runs", async () => {
    review = { open: true, parts: ["upload"] };
    const host = await openVideo("admin");
    expect(host.querySelector("#video-films-heading")?.textContent).toBe("Films");
    expect(host.querySelectorAll('[data-testid="video-card"]')).toHaveLength(1);
    expect(host.querySelector("#video-links-heading")?.textContent).toBe("Video links");
    expect(host.textContent).toContain("Older external links (Vimeo, Frame.io) stay here until cutover.");
    const linksSection = host.querySelector('[data-testid="video-links-section"]')!;
    expect(linksSection.querySelector(".empty")).toBeNull();
    expect(linksSection.textContent).toContain("No video links yet.");
    expect(paths().some((path) => path.includes("/assets?collection=video"))).toBe(false);
    expect(paths().some((path) => path.includes("/assets?collection=raw"))).toBe(false);
    expect(host.querySelector('[data-testid="new-film-dropzone"]')).not.toBeNull();
  });

  it("gate open without the upload part: cards but no dropzone and no Upload button", async () => {
    review = { open: true, parts: ["notes"] };
    const host = await openVideo("admin");
    expect(host.querySelectorAll('[data-testid="video-card"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="new-film-dropzone"]')).toBeNull();
    expect(host.textContent).not.toContain("Upload v3");
  });

  it("an assigned External editor reads the same panel through the External decoders", async () => {
    review = { open: true, parts: ["upload"] };
    const host = await openVideo("external_editor");
    expect(host.querySelectorAll('[data-testid="video-card"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="new-film-dropzone"]')).not.toBeNull();
  });

  it("a malformed list is refused by the strict External schema, not rendered", async () => {
    review = { open: true, parts: [] };
    authState.role = "external_editor";
    install();
    const base = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation((path: string, init?: unknown) => (path.endsWith("/videos") ? Promise.resolve({ videos: [{ ...video, surprise: true }] }) : base(path, init)));
    const host = mount();
    await render(<ProjectWorkspace projectId={PROJECT_ID} />);
    await flush();
    await click(tabButton(host, "Video"));
    await flush(40);
    expect(host.querySelectorAll('[data-testid="video-card"]')).toHaveLength(0);
  });

  it("a Photographer is never offered the Video tab and no review request is made", async () => {
    authState.role = "photographer";
    review = { open: true, parts: ["upload"] };
    install();
    const host = mount();
    await render(<ProjectWorkspace projectId={PROJECT_ID} />);
    await flush();
    expect([...host.querySelectorAll('[data-testid="project-overview-tab"]')].some((tab) => tab.textContent?.startsWith("Video"))).toBe(false);
    expect(paths().some((path) => path.endsWith("/video-review"))).toBe(false);
  });
});
