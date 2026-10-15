import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { resetUiPrefMemory } from "../../lib/ui-prefs";
import { installLocalStorageShim } from "../../testing/local-storage";
import { TEASER, WALK, all, buttonIn, mount, press, q, selectFilms, state, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/** #884: the tick and the selection bar exist for a person who may download but not share; each bar action is gated on its own. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@quincy/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@quincy/shared")>();
  return { ...actual, roleHasCapability: (role: Parameters<typeof actual.roleHasCapability>[0], capability: Parameters<typeof actual.roleHasCapability>[1]) => capability !== "shareVideo" && actual.roleHasCapability(role, capability) };
});
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "44444444-4444-4444-8444-444444444444", role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path) };
});

let storage: ReturnType<typeof installLocalStorageShim>;
const bar = () => q('[data-testid="review-link-selection-bar"]');
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

describe("a download-only role", () => {
  it("can tick films and download them, with no Create Review link and no Review links surface", async () => {
    await mount({ parts: ["upload", "download"] });
    await selectFilms("Teaser");
    expect(buttonIn(bar(), "Download")).toBeDefined();
    expect(buttonIn(bar(), "Create Review link")).toBeUndefined();
    expect(buttonIn(bar(), "Clear")).toBeDefined();
    expect(q('[data-testid="review-links-open"]')).toBeNull();
    await press(buttonIn(bar(), "Download"));
    expect(all("a", q('[data-testid="video-download-dialog"]')).length).toBe(1);
  });
  it("has no ticks without the download part", async () => {
    await mount({ parts: ["upload"] });
    expect(q('input[type="checkbox"], [role="checkbox"]')).toBeNull();
  });
});
