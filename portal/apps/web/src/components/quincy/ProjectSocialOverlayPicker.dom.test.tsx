import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSocialOverlaysResponse } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { projectDataKeys } from "../../lib/project-data";
import { ProjectSocialOverlayPicker } from "./ProjectSocialOverlayPicker";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), apiGet: (path: string) => apiGetMock(path), apiPut: (path: string, body: unknown) => apiPutMock(path, body) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = "11111111-1111-4111-8111-111111111111";
const id = { reel: "22222222-2222-4222-8222-222222222222", tiktok: "33333333-3333-4333-8333-333333333333", shorts: "44444444-4444-4444-8444-444444444444", old: "55555555-5555-4555-8555-555555555555" };
const choice = (key: keyof typeof id, name: string, platformLabel: string, extra: Partial<{ isDefault: boolean; archivedAt: number | null }> = {}) => ({ id: id[key], name, platformLabel, isDefault: false, archivedAt: null, ...extra });
const reel = choice("reel", "Instagram Reel", "Instagram", { isDefault: true });
const tiktok = choice("tiktok", "TikTok", "TikTok");
const shorts = choice("shorts", "YouTube Shorts", "YouTube");
const old = choice("old", "Old Story", "Instagram", { archivedAt: 5 });
const preview = (c: typeof reel) => ({ id: c.id, name: c.name, platformLabel: c.platformLabel, isDefault: c.isDefault, imageUrl: `/social-overlay-images/${c.id}/x`, width: 1080, height: 1920 });
/** A fake digest that still differs with the stored set's size. */
const rev = (stored: number) => String(stored).padStart(64, "0");
const state = (selected: Array<typeof reel>, available = [reel, tiktok, shorts]): ProjectSocialOverlaysResponse => {
  const live = selected.filter((c) => c.archivedAt === null);
  return { revision: rev(selected.length), available, selected, resolved: (live.length ? live : available.filter((c) => c.isDefault)).map(preview) };
};

let root: Root | null = null;
let host: HTMLDivElement;
let queryClient: QueryClient;
type Props = Partial<Parameters<typeof ProjectSocialOverlayPicker>[0]>;
const onArchivedRefusal = vi.fn();
const tree = (props: Props) => <QueryClientProvider client={queryClient}><ProjectSocialOverlayPicker projectId={projectId} role="admin" canEdit archived={false} onArchivedRefusal={onArchivedRefusal} {...props} /></QueryClientProvider>;
async function mount(props: Props = {}) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(tree(props)); await Promise.resolve(); });
  await waitFor(() => expect(host.querySelector('[data-testid="social-overlays-summary"], [aria-label="Social overlays"]')).not.toBeNull());
}
async function rerender(props: Props) { await act(async () => { root!.render(tree(props)); await Promise.resolve(); }); }
const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Social overlays"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const optionNames = () => options().map((option) => option.querySelector('[data-testid="overlay-option-name"]')!.textContent!.replace(/Default/, "").trim());
const text = () => host.textContent ?? "";

async function waitFor(assertion: () => void, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}
async function open() {
  await act(async () => { trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger().click(); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function pick(name: string) {
  const option = options().find((candidate) => candidate.textContent?.includes(name));
  if (!option) throw new Error(`No option ${name}`);
  await act(async () => { option.click(); await Promise.resolve(); });
}
async function closeWithEscape() {
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
}
const click = async (label: RegExp) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => label.test(candidate.textContent ?? ""));
  if (!button) throw new Error(`No button ${label}`);
  await act(async () => { button.click(); await Promise.resolve(); });
};

beforeEach(() => { onArchivedRefusal.mockReset(); apiGetMock.mockReset().mockResolvedValue(state([])); apiPutMock.mockReset(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; queryClient?.clear(); document.body.replaceChildren();
});

describe("ProjectSocialOverlayPicker (#870)", () => {
  it("says the Project offers the Default overlay when nothing is chosen, and lists only the non-archived overlays", async () => {
    apiGetMock.mockResolvedValue(state([], [reel, tiktok]));
    await mount();
    expect(text()).toContain("Nothing chosen");
    expect(text()).toContain("Instagram Reel");
    await open();
    expect(optionNames()).toEqual(["Instagram Reel", "TikTok"]);
  });

  it("saves several picks as one request on close, naming the stored set it last saw, and shows them after", async () => {
    apiPutMock.mockResolvedValue(state([tiktok, shorts]));
    await mount();
    await open(); await pick("TikTok"); await pick("YouTube Shorts"); await closeWithEscape();
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/social-overlays`, { overlayIds: [id.tiktok, id.shorts], expectedRevision: rev(0) });
    await waitFor(() => expect(text()).toContain("TikTok, YouTube Shorts"));
    await open();
    expect(options().filter((option) => option.getAttribute("aria-selected") === "true").length).toBe(2);
  });

  it("sends nothing when the list closes unchanged", async () => {
    apiGetMock.mockResolvedValue(state([tiktok]));
    await mount();
    await open(); await closeWithEscape();
    expect(apiPutMock).not.toHaveBeenCalled();
  });

  it("clears the choice back to the Default", async () => {
    apiGetMock.mockResolvedValue(state([tiktok]));
    apiPutMock.mockResolvedValue(state([]));
    await mount();
    await open(); await pick("TikTok"); await closeWithEscape();
    expect(apiPutMock).toHaveBeenCalledWith(expect.any(String), { overlayIds: [], expectedRevision: rev(1) });
    await waitFor(() => expect(text()).toContain("Nothing chosen"));
  });

  it("shows an archived choice as Archived outside the list, keeps it in expectedOverlayIds, and never offers it", async () => {
    apiGetMock.mockResolvedValue(state([old, tiktok]));
    apiPutMock.mockResolvedValue(state([old, tiktok, shorts]));
    await mount();
    expect(text()).toContain("Old Story");
    expect(text()).toContain("Archived");
    await open();
    expect(optionNames()).not.toContain("Old Story");
    await pick("YouTube Shorts"); await closeWithEscape();
    expect(apiPutMock).toHaveBeenCalledWith(expect.any(String), { overlayIds: [id.tiktok, id.shorts], expectedRevision: rev(2) });
  });

  it("keeps the trigger on the attempted pick while the save is pending and will not reopen", async () => {
    let finish!: (value: unknown) => void;
    apiPutMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await mount();
    await open(); await pick("TikTok"); await closeWithEscape();
    expect(text()).toContain("TikTok");
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    await act(async () => { trigger().click(); await Promise.resolve(); });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => { finish(state([tiktok])); await Promise.resolve(); });
    await waitFor(() => expect(trigger().getAttribute("aria-busy")).toBeNull());
  });

  it("is not overwritten by a read that was in flight when the save finished", async () => {
    let lateRead!: (value: unknown) => void;
    apiGetMock.mockResolvedValueOnce(state([])).mockReturnValueOnce(new Promise((resolve) => { lateRead = resolve; }));
    apiPutMock.mockResolvedValue(state([tiktok]));
    await mount();
    await open(); await pick("TikTok"); await closeWithEscape();
    await waitFor(() => expect(text()).toContain("TikTok"));
    await act(async () => { lateRead(state([])); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(text()).toContain("TikTok");
    expect(text()).not.toContain("Nothing chosen");
  });

  it("drops an unsaved attempt when the picker is reopened after a failed save", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }));
    await mount();
    await open(); await pick("TikTok"); await closeWithEscape();
    await waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    await open(); await closeWithEscape();
    expect(apiPutMock).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("Nothing chosen");
  });

  it("returns focus to the trigger on close", async () => {
    apiGetMock.mockResolvedValue(state([tiktok]));
    await mount();
    await open(); await closeWithEscape();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("keeps the attempted pick after a failed save, says so, and Retry sends it again", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" })).mockResolvedValueOnce(state([tiktok]));
    await mount();
    await open(); await pick("TikTok"); await closeWithEscape();
    await waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be saved"));
    expect(text()).toContain("TikTok");
    await click(/Retry/);
    await waitFor(() => expect(host.querySelector('[role="alert"]')).toBeNull());
    expect(apiPutMock).toHaveBeenCalledTimes(2);
    expect(apiPutMock.mock.calls[1]).toEqual(apiPutMock.mock.calls[0]);
  });

  it("on a conflict shows the fresh state only after an explicit Reload", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("Changed", 409, { error: "Changed", code: "social_overlays_conflict", current: state([shorts]) }));
    await mount();
    await open(); await pick("TikTok"); await closeWithEscape();
    await waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("changed"));
    expect(text()).toContain("TikTok");
    await click(/Reload/);
    await waitFor(() => expect(text()).toContain("YouTube Shorts"));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(apiPutMock).toHaveBeenCalledTimes(1);
  });

  it("tells the header, and asks for the Project detail again, when the server says the Project is archived", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("Archived", 409, { error: "Archived", code: "project_archived" }));
    await mount();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await open(); await pick("TikTok"); await closeWithEscape();
    await waitFor(() => expect(onArchivedRefusal).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: projectDataKeys.detail(projectId) }));
  });

  it("stops at 50 selected overlays, disables the rest and says why", async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Overlay ${String(i).padStart(2, "0")}`, platformLabel: "x", isDefault: i === 0, archivedAt: null }));
    apiGetMock.mockResolvedValue(state([], many));
    await mount();
    await open();
    for (const option of options().slice(0, 50)) await act(async () => { option.click(); await Promise.resolve(); });
    const last = options()[50]!;
    expect(last.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("up to 50");
    await act(async () => { last.click(); await Promise.resolve(); });
    await closeWithEscape();
    expect((apiPutMock.mock.calls[0]?.[1] as { overlayIds: string[] }).overlayIds).toHaveLength(50);
  });

  it("goes read-only when the server says the Project is archived", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("Archived", 409, { error: "Archived", code: "project_archived" }));
    await mount();
    await open(); await pick("TikTok"); await closeWithEscape();
    await waitFor(() => expect(host.querySelector('button[aria-label="Social overlays"]')).toBeNull());
    expect(text()).toContain("read-only");
  });

  it("shows the resolved names without a control when the caller cannot edit or the Project is archived", async () => {
    apiGetMock.mockResolvedValue(state([tiktok]));
    await mount({ canEdit: false });
    expect(host.querySelector('button[aria-label="Social overlays"]')).toBeNull();
    expect(text()).toContain("TikTok");
    await rerender({ canEdit: true, archived: true });
    expect(host.querySelector('button[aria-label="Social overlays"]')).toBeNull();
    expect(text()).toContain("TikTok");
  });

  it("tells staff how to add overlays when the library is empty, and disables the control", async () => {
    apiGetMock.mockResolvedValue({ available: [], selected: [], resolved: [], revision: rev(0) });
    await mount();
    expect(text()).toContain("Social preview unavailable");
    expect(trigger().disabled).toBe(true);
  });

  it("reads the External-safe surface for an External editor and never offers a control", async () => {
    apiGetMock.mockResolvedValue(state([tiktok]));
    await mount({ role: "external_editor", canEdit: false });
    expect(apiGetMock).toHaveBeenCalledWith(`/api/projects/${projectId}/social-overlays`);
    expect(text()).toContain("TikTok");
  });
});
