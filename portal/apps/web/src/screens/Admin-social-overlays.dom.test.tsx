import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pngBytes } from "../../../../packages/shared/src/testing/png-fixture";
import type { SocialOverlayDto } from "@quincy/shared";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiPostFormMock = vi.hoisted(() => vi.fn<(path: string, body: FormData) => Promise<unknown>>());
const confirmMock = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const capabilities = vi.hoisted(() => ({ list: ["adminBackend", "manageUsers"] as string[] }));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiPostForm: (path: string, body: FormData) => apiPostFormMock(path, body) };
});
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "admin", capabilities: capabilities.list, can: (capability: string) => capabilities.list.includes(capability) }) }));
vi.mock("../lib/stages", () => ({ presentationStages: (stages: readonly unknown[]) => stages, useStages: () => ({ stages: [], isLoading: false, refreshStages: vi.fn() }) }));
vi.mock("../lib/project-data", () => ({ useOptionalProjectQueryClient: () => ({}), invalidateActiveProjectDetails: vi.fn() }));
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));
vi.mock("../lib/auth", () => ({ impersonateUser: vi.fn() }));

import { Admin } from "./Admin";
import { ApiError } from "../lib/api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement;

const overlay = (overrides: Partial<SocialOverlayDto> = {}): SocialOverlayDto => ({
  id: "11111111-1111-4111-8111-111111111111", name: "Instagram Reel", platformLabel: "Instagram", isDefault: true, archivedAt: null, imageUrl: "/social-overlay-images/11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  width: 1080, height: 1920, bytes: 2048, revision: 1, createdAt: 1, updatedAt: 1, updatedBy: { id: "u1", name: "Admin Person" }, ...overrides,
});
const tiktok = (overrides: Partial<SocialOverlayDto> = {}) => overlay({ id: "22222222-2222-4222-8222-222222222222", name: "TikTok", platformLabel: "TikTok", isDefault: false, imageUrl: "/social-overlay-images/22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ...overrides });

async function flush(times = 10) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); }); }
async function press(el: Element | null | undefined) { await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }); await flush(); }
async function type(el: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function pick(file: File) {
  const input = document.body.querySelector<HTMLInputElement>('[data-testid="file-pick-input"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush(15);
}
const buttons = (scope: ParentNode = document.body) => [...scope.querySelectorAll("button")];
const button = (label: string | RegExp, scope: ParentNode = document.body) => buttons(scope).find((b) => { const t = b.getAttribute("aria-label") ?? b.textContent ?? ""; return typeof label === "string" ? t === label : label.test(t); });
const rows = () => [...host.querySelectorAll('[data-testid="social-overlay-row"]')];
const pngFile = (name = "overlay.png", spec = {}, type = "image/png") => new File([pngBytes(spec) as BlobPart], name, { type });

async function mount(list: SocialOverlayDto[] = [overlay(), tiktok()]) {
  apiGetMock.mockImplementation(async (path: string) => {
    if (path === "/api/admin/social-overlays") return { overlays: list };
    if (path === "/api/users") return { users: [] };
    return { agencies: [], agents: [], stages: [], events: [], items: [] };
  });
  await act(async () => { root!.render(<Admin currentUserId="u1" />); });
  await flush();
}
async function openTab() { await press(host.querySelector('[role="tab"][id="admin-tab-social"]')); }

beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  capabilities.list = ["adminBackend", "manageUsers"];
  for (const mock of [apiGetMock, apiPostMock, apiPatchMock, apiPostFormMock, confirmMock]) mock.mockReset();
  confirmMock.mockResolvedValue(true);
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; host.remove(); document.body.innerHTML = ""; });

describe("Admin > Social overlays (#869)", () => {
  it("offers the tab only to a holder of adminBackend", async () => {
    capabilities.list = ["manageUsers"];
    await mount();
    expect(host.querySelector('[role="tab"][id="admin-tab-social"]')).toBeNull();
    await act(async () => { root!.unmount(); }); root = createRoot(host);
    capabilities.list = ["adminBackend"];
    await mount();
    expect(host.querySelector('[role="tab"][id="admin-tab-social"]')?.textContent).toBe("Social overlays");
  });

  it("says the first upload becomes the Default when the library is empty", async () => {
    await mount([]); await openTab();
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain("The first overlay you upload becomes the Default.");
    expect(rows()).toHaveLength(0);
  });

  it("lists overlays with the Default badge and no Archive action on the Default", async () => {
    await mount(); await openTab();
    expect(rows()).toHaveLength(2);
    const [first, second] = rows() as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain("Default");
    expect(button("Archive Instagram Reel", first)).toBeUndefined();
    expect(button("Archive TikTok", second)).toBeDefined();
    expect(first.querySelector("img")?.getAttribute("src")).toBe(overlay().imageUrl);
  });

  it("uploads: posts a FormData with name, platform and the PNG, then shows the new row", async () => {
    await mount([]); await openTab();
    apiPostFormMock.mockResolvedValue({ overlay: overlay() });
    await press(button("Upload overlay"));
    await type(document.body.querySelector<HTMLInputElement>("#social-overlay-name")!, "Instagram Reel");
    await type(document.body.querySelector<HTMLInputElement>("#social-overlay-platform")!, "Instagram");
    await pick(pngFile());
    await press(button(/^Upload$/, document.body.querySelector('[data-testid="social-overlay-dialog"]')!));
    expect(apiPostFormMock).toHaveBeenCalledTimes(1);
    const [path, form] = apiPostFormMock.mock.calls[0]!;
    expect(path).toBe("/api/admin/social-overlays");
    expect(form.get("name")).toBe("Instagram Reel"); expect(form.get("platformLabel")).toBe("Instagram");
    expect((form.get("image") as File).name).toBe("overlay.png");
    expect(rows()).toHaveLength(1);
    expect(document.body.querySelector('[data-testid="social-overlay-dialog"]')).toBeNull();
  });

  it("refuses a non-PNG, an over-8 MB file and a PNG without alpha before any request", async () => {
    await mount([]); await openTab(); await press(button("Upload overlay"));
    await pick(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "photo.jpg", { type: "image/jpeg" }));
    expect(document.body.textContent).toContain("That file is not a valid PNG.");
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    await pick(big);
    expect(document.body.textContent).toContain("larger than 8 MB");
    await pick(pngFile("flat.png", { colourType: 2 }));
    expect(document.body.textContent).toContain("no transparency");
    await type(document.body.querySelector<HTMLInputElement>("#social-overlay-name")!, "N");
    await type(document.body.querySelector<HTMLInputElement>("#social-overlay-platform")!, "P");
    expect(button(/^Upload$/, document.body.querySelector('[data-testid="social-overlay-dialog"]')!)?.hasAttribute("disabled")).toBe(true);
    expect(apiPostFormMock).not.toHaveBeenCalled();
  });

  it("shows friendly copy when the server answers 422 and keeps the dialog open", async () => {
    await mount([]); await openTab(); await press(button("Upload overlay"));
    apiPostFormMock.mockRejectedValue(new ApiError("raw server text", 422, { code: "png_not_9x16" }));
    await type(document.body.querySelector<HTMLInputElement>("#social-overlay-name")!, "N");
    await type(document.body.querySelector<HTMLInputElement>("#social-overlay-platform")!, "P");
    await pick(pngFile());
    await press(button(/^Upload$/, document.body.querySelector('[data-testid="social-overlay-dialog"]')!));
    expect(document.body.textContent).toContain("must be 9:16");
    expect(document.body.textContent).not.toContain("raw server text");
    expect(document.body.querySelector('[data-testid="social-overlay-dialog"]')).not.toBeNull();
  });

  it("archives after confirming, hides the row unless Show archived is on, and unarchives", async () => {
    await mount(); await openTab();
    apiPostMock.mockResolvedValueOnce({ overlay: tiktok({ archivedAt: 5, revision: 2 }) });
    await press(button("Archive TikTok"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith("/api/admin/social-overlays/22222222-2222-4222-8222-222222222222/archive", { expectedRevision: 1 });
    expect(rows()).toHaveLength(1);
    // The switch's real checkbox sits beside its role=switch span inside the label.
    await press(host.querySelector('[role="switch"][aria-label="Show archived"]')!.parentElement!.querySelector('input[type="checkbox"]'));
    expect(rows()).toHaveLength(2);
    expect(rows()[1]!.textContent).toContain("Archived");
    apiPostMock.mockResolvedValueOnce({ overlay: tiktok({ revision: 3 }) });
    await press(button("Unarchive TikTok"));
    expect(apiPostMock).toHaveBeenLastCalledWith("/api/admin/social-overlays/22222222-2222-4222-8222-222222222222/unarchive", { expectedRevision: 2 });
    expect(rows()[1]!.textContent).not.toContain("Archived");
  });

  it("does not archive when the confirm is declined", async () => {
    await mount(); await openTab();
    confirmMock.mockResolvedValueOnce(false);
    await press(button("Archive TikTok"));
    expect(apiPostMock).not.toHaveBeenCalled(); expect(rows()).toHaveLength(2);
  });

  it("renames through a dialog that PATCHes name and platform with the expected revision", async () => {
    await mount(); await openTab();
    apiPatchMock.mockResolvedValue({ overlay: tiktok({ name: "TikTok Vertical", platformLabel: "TT", revision: 2 }) });
    await press(button("Rename TikTok"));
    await type(document.body.querySelector<HTMLInputElement>("#social-overlay-name")!, "TikTok Vertical");
    await type(document.body.querySelector<HTMLInputElement>("#social-overlay-platform")!, "TT");
    await press(button(/^Save$/, document.body.querySelector('[data-testid="social-overlay-dialog"]')!));
    expect(apiPatchMock).toHaveBeenCalledWith("/api/admin/social-overlays/22222222-2222-4222-8222-222222222222", { name: "TikTok Vertical", platformLabel: "TT", expectedRevision: 1 });
    expect(rows()[1]!.textContent).toContain("TikTok Vertical");
  });

  it("replaces the image and swaps the thumbnail URL", async () => {
    await mount(); await openTab();
    const next = tiktok({ revision: 2, imageUrl: "/social-overlay-images/22222222-2222-4222-8222-222222222222/cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    apiPostFormMock.mockResolvedValue({ overlay: next });
    await press(button("Replace image for TikTok"));
    await pick(pngFile());
    await press(button(/^Replace$/, document.body.querySelector('[data-testid="social-overlay-dialog"]')!));
    const [path, form] = apiPostFormMock.mock.calls[0]!;
    expect(path).toBe("/api/admin/social-overlays/22222222-2222-4222-8222-222222222222/image");
    expect(form.get("expectedRevision")).toBe("1");
    expect(rows()[1]!.querySelector("img")?.getAttribute("src")).toBe(next.imageUrl);
  });
});
