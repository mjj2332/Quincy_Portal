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
import { VideoCollectionPanel } from "./VideoCollectionPanel";
import "../../testing/dom-polyfills";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("../../lib/video-poster", () => ({ captureVideoPoster: () => Promise.resolve(null) }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path) }));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ids = { video: "88888888-8888-4888-8888-888888888888", a: "77777777-7777-4777-8777-777777777777", b: "66666666-6666-4666-8666-666666666666", c: "55555555-5555-4555-8555-555555555555" };
let stub: VideoElementStub; let viewport: MockViewport;
let root: Root | null = null; let client: QueryClient;
let held: Array<{ assetId: string; version: number }>;
const videoNow = (): VideoDto => fixtureVideo({ id: ids.video, versions: held.map((v) => fixtureVersion(v)) });
function Probe() { client = useQueryClient(); return null; }
async function flush(times = 8) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function openViewer(parts: string[]) {
  apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/videos")) return { videos: [videoNow()] }; if (path.includes("/notes") || path.endsWith("/decisions")) return { notes: [], versions: [] }; throw new Error(`unrouted ${path}`); });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<QuincyQueryProvider principalId={auth.userId} role="editor"><Probe /><VideoCollectionPanel projectId={PROJECT} role="editor" review={{ open: true, parts: parts as never }} /></QuincyQueryProvider>); });
  await flush();
  const open = [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Open review")!;
  await act(async () => { open.click(); });
  const deadline = Date.now() + 10_000;
  while (!document.querySelector('[role="dialog"] video')) { if (Date.now() > deadline) throw new Error("the viewer never mounted"); await flush(1); }
  await flush(4);
}
const refetch = async () => { await act(async () => { await client.invalidateQueries({ queryKey: projectDataKeys.videos(PROJECT) }); }); await flush(6); };
async function pickVersion(label: string) {
  const trigger = document.querySelector<HTMLElement>('[role="dialog"] [role="combobox"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
  await flush(6);
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith(label))!.click(); });
  await flush(8);
}

beforeEach(() => { stub = installVideoElementStub(); viewport = mockViewport({ width: 1440 }); apiGetMock.mockReset(); held = [{ assetId: ids.a, version: 3 }, { assetId: ids.b, version: 2 }, { assetId: ids.c, version: 1 }]; });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; resetVideoUploadStore(); stub.dispose(); viewport.restore(); document.body.replaceChildren(); });

describe("a Version removed in another tab while the viewer is open (#776 E)", () => {
  it("moves the viewer to the current Version and does not jump back to the removed one when it is restored", async () => {
    await openViewer([]);
    await pickVersion("v1");
    expect(tid("video-version-label")!.textContent).toContain("v1");
    held = [{ assetId: ids.a, version: 3 }, { assetId: ids.b, version: 2 }];
    await refetch();
    expect(tid("video-version-label")!.textContent).toContain("v3");
    held = [{ assetId: ids.a, version: 3 }, { assetId: ids.b, version: 2 }, { assetId: ids.c, version: 1 }];
    await refetch();
    expect(tid("video-version-label")!.textContent).toContain("v3");
  });

  it("leaves Compare for the single view when one of its sides was removed", async () => {
    await openViewer(["compare"]);
    await act(async () => { tid("video-compare-toggle")!.click(); });
    await flush(10);
    expect(tid("video-compare-toggle")!.getAttribute("aria-pressed")).toBe("true");
    held = [{ assetId: ids.a, version: 3 }, { assetId: ids.c, version: 1 }];
    await refetch();
    await flush(6);
    expect(tid("video-compare-toggle")!.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector('[data-testid="video-compare"]')).toBeNull();
  });
});
