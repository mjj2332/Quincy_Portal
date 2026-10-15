import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDto } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import { projectDataKeys } from "../../lib/project-data";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { fixtureVersion, fixtureVideo } from "../../testing/video-trash-fixtures";
import { restoreVideoVersion } from "../../lib/video-trash-data";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
import "../../testing/dom-polyfills";
vi.mock("./VideoNoteEditor", async () => await import("../../testing/video-note-editor-stub"));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const spies = vi.hoisted(() => ({ forgotten: [] as string[] }));
vi.mock("../../lib/video-approval-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/video-approval-store")>();
  return { ...actual, createVideoApprovalStore: (key: string) => { const store = actual.createVideoApprovalStore(key); const forget = store.forget.bind(store); store.forget = (slot: string) => { spies.forgotten.push(slot); forget(slot); }; return store; } };
});
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", a: "77777777-7777-4777-8777-777777777777", b: "66666666-6666-4666-8666-666666666666" };
const BOTH = [{ assetId: ids.a, version: 2 }, { assetId: ids.b, version: 1 }];
let stub: VideoElementStub; let viewport: MockViewport;
let root: Root | null = null; let client: QueryClient;
let held: Array<{ assetId: string; version: number }>;
let listFails = false;
const videoNow = (): VideoDto => fixtureVideo({ id: ids.video, versions: held.map((v) => fixtureVersion(v)) });
function Probe() { client = useQueryClient(); return null; }
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const composer = () => tid("video-note-composer")!.querySelector<HTMLTextAreaElement>("textarea")!;
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function mount(parts: string[]) {
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) { if (listFails) throw new Error("offline"); return { videos: [videoNow()] }; }
    if (path.includes("/notes")) return { notes: [] };
    if (path.endsWith("/decisions")) return { versions: [] };
    throw new Error(`unrouted ${path}`);
  });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><Probe /><VideoCollectionPanel projectId={PROJECT} role="editor" review={{ open: true, parts: parts as never }} /></QuincyQueryProvider>); });
  await flush();
}
async function openViewer() {
  const open = document.querySelector<HTMLElement>('[data-testid="video-card-open"]')!;
  await act(async () => { open.click(); });
  const deadline = Date.now() + 10_000;
  while (!document.querySelector('[role="dialog"] video')) { if (Date.now() > deadline) throw new Error("the viewer never mounted"); await flush(1); }
  await flush(6);
}
async function closeViewer() {
  const close = [...document.querySelectorAll<HTMLElement>('[data-testid="video-review-viewer"] button')].find((b) => b.textContent === "Video")!;
  await act(async () => { close.click(); });
  await flush(6);
}
const refetch = async () => { await act(async () => { await client.invalidateQueries({ queryKey: projectDataKeys.videos(PROJECT) }); }); await flush(6); };
async function pickVersion(label: string) {
  const trigger = document.querySelector<HTMLElement>('[role="dialog"] [role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(label))!.click(); });
  await flush(8);
}

beforeEach(() => { stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 }); apiGetMock.mockReset(); apiPostMock.mockReset(); held = [...BOTH]; listFails = false; spies.forgotten.length = 0; });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); viewport.restore(); document.body.replaceChildren(); });

describe("a Version that left the list keeps what the person typed, dormant (#776 E)", () => {
  it("another tab removes and restores a Version with an open draft: the draft is still there (dormant while it was gone)", async () => {
    await mount(["notes"]);
    await openViewer();
    await pickVersion("v1");
    await type(composer(), "an unsent note");
    held = [BOTH[0]!];
    await refetch();
    held = [...BOTH];
    await refetch();
    await pickVersion("v1");
    expect(composer().value).toBe("an unsent note");
  });

  it("a Version that left the list while the viewer was closed keeps its draft too", async () => {
    await mount(["notes"]);
    await openViewer();
    await pickVersion("v1");
    await type(composer(), "an unsent note");
    await closeViewer();
    held = [BOTH[0]!];
    await refetch();
    held = [...BOTH];
    await refetch();
    await openViewer();
    await pickVersion("v1");
    expect(composer().value).toBe("an unsent note");
  });

  it("an older restore answer that lands after a newer one does not erase the draft on the Version it lacks", async () => {
    await mount(["notes"]);
    await openViewer();
    await pickVersion("v2");
    await type(composer(), "a fresh draft");
    const ctx = { queryClient: client, projectId: PROJECT, videoId: ids.video };
    // v1's restore was answered from a snapshot that lacks v2 and is delayed past v2's restore.
    let answerV1!: () => void;
    apiPostMock.mockImplementationOnce(() => new Promise((resolve) => { answerV1 = () => resolve({ video: fixtureVideo({ id: ids.video, versions: [fixtureVersion({ assetId: ids.b, version: 1 })] }) }); }));
    apiPostMock.mockImplementationOnce(async () => ({ video: videoNow() }));
    const first = restoreVideoVersion({ ...ctx, assetId: ids.b });
    const second = restoreVideoVersion({ ...ctx, assetId: ids.a });
    await act(async () => { await second; });
    // The convergence refetch after v1's answer is slow, so the stale snapshot is what the panel shows meanwhile.
    let releaseList!: () => void;
    const routed = apiGetMock.getMockImplementation()!;
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) { await new Promise<void>((resolve) => { releaseList = resolve; }); return { videos: [videoNow()] }; } return routed(path); });
    await act(async () => { answerV1(); });
    await flush(8);
    await act(async () => { releaseList(); await first; });
    await flush(8);
    await pickVersion("v1");
    await pickVersion("v2");
    expect(composer().value).toBe("a fresh draft");
  });

  it("a failed read of the list retires nothing", async () => {
    await mount(["notes"]);
    await openViewer();
    await pickVersion("v1");
    await type(composer(), "an unsent note");
    listFails = true;
    held = [BOTH[0]!];
    await refetch();
    listFails = false;
    held = [...BOTH];
    await refetch();
    await pickVersion("v2");
    await pickVersion("v1");
    expect(composer().value).toBe("an unsent note");
  });

  it("a Video that left the list keeps its decision drafts: nothing in the list diff forgets them", async () => {
    await mount(["delivery"]);
    held = [];
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [] }; throw new Error(`unrouted ${path}`); });
    await refetch();
    expect(spies.forgotten).toEqual([]);
  });
});
