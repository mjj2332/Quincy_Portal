import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoTrashItem } from "@quincy/shared";
import { QuincyQueryProvider } from "../../lib/query-client";
import { clearToasts } from "../../lib/toast-store";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { FIXTURE_PERSON, fixtureVersion, fixtureVideo } from "../../testing/video-trash-fixtures";
import { VideoCollectionPanel } from "./VideoCollectionPanel";
import "../../testing/dom-polyfills";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const api = vi.hoisted(() => ({ apiGet: vi.fn<(path: string) => Promise<unknown>>(), apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), ...api }));

/** The Trash dialog opens on itself, never on Close (#776 E): the list arrives after the dialog opens, when Close was the only tabbable control. */
const PROJECT = "11111111-1111-4111-8111-111111111111";
const VIDEO = "88888888-8888-4888-8888-888888888888";
const DAY = 86_400_000;
const item = (over: Partial<VideoTrashItem> = {}): VideoTrashItem => ({ kind: "version", videoId: VIDEO, title: "Main walkthrough", assetId: "77777777-7777-4777-8777-777777777777", version: 2, canRestore: true, removedAt: "2026-10-09T01:00:00.000Z", removedBy: FIXTURE_PERSON, purgeAt: new Date(Date.now() + 5 * DAY).toISOString(), ...over });

let root: Root | null = null; let host: HTMLElement; let trash: VideoTrashItem[];
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function openTrash() {
  api.apiGet.mockImplementation(async (path) => {
    if (path.endsWith("/videos")) return { videos: [fixtureVideo({ id: VIDEO, versions: [fixtureVersion({ assetId: "66666666-6666-4666-8666-666666666666", version: 1 })] })] };
    if (path.endsWith("/video-trash")) return { retentionDays: 30, items: trash };
    if (path.includes("/notes") || path.endsWith("/decisions")) return { notes: [], versions: [] };
    throw new Error(`unrouted ${path}`);
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><VideoCollectionPanel projectId={PROJECT} role="editor" archived={false} review={{ open: true, parts: ["trash"] as never }} /></QuincyQueryProvider>); });
  await flush();
  const opener = tid("video-trash-open")!;
  opener.focus();
  await act(async () => { opener.click(); });
  const deadline = Date.now() + 10_000;
  while (!tid("video-trash-dialog")) { if (Date.now() > deadline) throw new Error("the Trash dialog never mounted"); await flush(1); }
  await flush(6);
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset()); clearToasts();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); document.body.replaceChildren(); vi.unstubAllGlobals(); clearToasts(); });

describe.each([
  ["empty", () => []],
  ["populated", () => [item(), item({ kind: "video", videoId: "88888888-8888-4888-8888-888888888899", title: "Sunset exterior", versionCount: 3, assetId: undefined })]],
])("Video Trash dialog focus, %s (#776 E)", (_name, make) => {
  it("does not open on Close", async () => {
    trash = make(); await openTrash();
    expect(document.activeElement).not.toBe(tid("video-trash-close"));
    expect(tid("video-trash-dialog")!.contains(document.activeElement)).toBe(true);
  });
});
