import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { videoVersionDownloadUrl } from "@quincy/shared";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { A2, B1, PROJECT, TEASER, WALK, all, buttonIn, flush, mount, press, q, selectFilms, state, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/** #884 (D24, story 22): the selection bar offers Download beside Create Review link, as one current-Version link per ticked film. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "44444444-4444-4444-8444-444444444444", role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

let storage: ReturnType<typeof installLocalStorageShim>;
const bar = () => q('[data-testid="review-link-selection-bar"]');
const dlg = () => q('[data-testid="video-download-dialog"]');
beforeEach(() => {
  storage = installLocalStorageShim(); resetUiPrefMemory();
  state.links = []; state.videos = [WALK, TEASER];
  apiGetMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); resetUiPrefMemory(); storage.restore(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("the selection bar's Download", () => {
  it("is offered with the download part and capability, beside Create Review link and Clear", async () => {
    await mount({ parts: ["upload", "links", "download"] });
    await selectFilms("Teaser");
    expect(buttonIn(bar(), "Download")).toBeDefined();
    expect(buttonIn(bar(), "Create Review link")).toBeDefined();
  });

  it("is absent without the download part", async () => {
    await mount({ parts: ["upload", "links"] });
    await selectFilms("Teaser");
    expect(buttonIn(bar(), "Download")).toBeUndefined();
  });

  it("opens a dialog listing one current-Version download link per ticked film", async () => {
    await mount({ parts: ["upload", "links", "download"] });
    await selectFilms("Main walkthrough", "Teaser");
    await press(buttonIn(bar(), "Download"));
    const links = all<HTMLAnchorElement>("a", dlg());
    expect(links.map((a) => a.getAttribute("href"))).toEqual([videoVersionDownloadUrl(PROJECT, A2), videoVersionDownloadUrl(PROJECT, B1)]);
    expect(links.every((a) => a.hasAttribute("download"))).toBe(true);
    expect(links.map((a) => a.textContent)).toEqual(["Main walkthrough · v2", "Teaser · v1"]);
  });

  it("resolves the ticks against the whole collection: a film a filter hides is still listed", async () => {
    state.videos = [WALK, { ...TEASER, reviewStatus: "approved_internal" } as typeof TEASER];
    await mount({ parts: ["upload", "links", "download"] });
    await selectFilms("Teaser");
    const trigger = q('[data-testid="video-grid-status"]')!;
    await act(async () => { trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); });
    await flush(6);
    await act(async () => { all('[role="option"]').find((o) => o.textContent?.startsWith("In review"))!.click(); });
    await flush(8);
    expect(all('[data-testid="video-card"]')).toHaveLength(1);
    await press(buttonIn(bar(), "Download"));
    expect(all<HTMLAnchorElement>("a", dlg()).map((a) => a.getAttribute("href"))).toEqual([videoVersionDownloadUrl(PROJECT, B1)]);
  });
});
