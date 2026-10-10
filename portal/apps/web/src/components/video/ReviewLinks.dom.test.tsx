import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { A1, A2, B1, L1, L2, L3, NOW, PROJECT, V1, V2, TEASER, WALK, all, button, buttonIn, checkbox, dialog, flush, linkOf, member, mount, openList, press, q, refused, selectFilms, state, text, toggle, type, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/**
 * #741 11b: the staff UI for client Review links, driven through the Video Collection the way a person meets it. The API is mocked at
 * `lib/api` (the wire shapes are `packages/shared/src/review-links.ts`); "now" is pinned with a fake `Date` only so Base UI's timers run.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
/** The toasts pushed (the live region is mounted by the shells, not by the panel). */
const toasts = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("../../lib/toast-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/toast-store")>();
  return { ...actual, pushToast: (message: string, tone?: "success" | "error" | "caution") => { toasts.list.push(tone === "error" ? `error: ${message}` : message); return 0; } };
});
const live = () => toasts.list.join("\n");
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiPutMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body), apiPut: (path: string, body: unknown) => apiPutMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
  state.links = []; state.videos = [WALK, TEASER];
  for (const mock of [apiGetMock, apiPostMock, apiPatchMock, apiPutMock, apiDeleteMock]) mock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
  toasts.list = [];
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("gating: shipped dark, behind the links part and shareVideo", () => {
  it("shows nothing and never asks for links without the `links` part", async () => {
    await mount({ parts: ["upload"] });
    expect(q('[data-testid="review-links-open"]')).toBeNull();
    expect(checkbox("Select Main walkthrough")).toBeNull();
    expect(apiGetMock.mock.calls.some(([path]) => path.endsWith("/review-links"))).toBe(false);
  });
  it("shows nothing to an External editor even with the part on, and never asks", async () => {
    await mount({ role: "external_editor" });
    expect(q('[data-testid="review-links-open"]')).toBeNull();
    expect(checkbox("Select Main walkthrough")).toBeNull();
    expect(apiGetMock.mock.calls.some(([path]) => path.endsWith("/review-links"))).toBe(false);
  });
  it("shows nothing to a Photographer (no shareVideo)", async () => {
    await mount({ role: "photographer" });
    expect(q('[data-testid="review-links-open"]')).toBeNull();
  });
  it("shows the button and a checkbox per card to staff with the part on", async () => {
    await mount();
    expect(q('[data-testid="review-links-open"]')?.textContent).toContain("Review links");
    expect(checkbox("Select Main walkthrough")).not.toBeNull();
    expect(checkbox("Select Teaser")).not.toBeNull();
  });
});

describe("the list", () => {
  it("lists each link with its status, expiry, Video count and last opened", async () => {
    state.links = [
      linkOf({ activity: { openSessions: 2, lastOpenedAt: "2026-10-10T01:00:00.000Z", verifiedGuests: [] } }),
      linkOf({ id: L2, label: "Jones", status: "expired", expiresAt: "2026-10-01T12:59:00.000Z", videos: [member(V1, "Main walkthrough", [[A2, 2]]), member(V2, "Teaser", [[B1, 1]])] }),
      linkOf({ id: L3, label: null, status: "revoked", revokedAt: "2026-10-09T05:00:00.000Z" }),
    ];
    await mount(); await openList();
    const rows = all('[data-testid="review-link-row"]');
    expect(rows).toHaveLength(3);
    expect(text(rows[0])).toContain("Smith family"); expect(text(rows[0])).toContain("Active"); expect(text(rows[0])).toContain("1 Video"); expect(text(rows[0])).toContain("9 Nov 2026"); expect(text(rows[0])).toContain("2h ago"); expect(text(rows[0])).toContain("2 open now");
    expect(text(rows[1])).toContain("Expired"); expect(text(rows[1])).toContain("2 Videos"); expect(text(rows[1])).toContain("Not opened yet");
    expect(text(rows[2])).toContain("Revoked"); expect(text(rows[2])).toContain("Untitled link");
  });
  it("says so when there are none, and points at the checkboxes", async () => {
    await mount(); await openList();
    expect(text(dialog())).toContain("No Review links yet.");
    expect(text(dialog())).toContain("Tick films");
  });
  it("shows a retry when the list fails to load", async () => {
    apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/review-links")) throw refused(400, { error: "Boom" }); if (path.endsWith("/videos")) return { videos: state.videos }; throw new Error(path); });
    await mount(); await openList();
    expect(q('[role="alert"]', dialog() as ParentNode)).not.toBeNull();
    expect(buttonIn(dialog(), "Retry")).toBeDefined();
  });
  it("a Video's card carries up to two link chips and +N, and a chip opens that link's detail", async () => {
    state.links = [linkOf(), linkOf({ id: L2, label: "Jones", status: "expired" }), linkOf({ id: L3, label: "Wu", status: "revoked", revokedAt: "2026-10-09T05:00:00.000Z" })];
    await mount();
    const chips = q('[data-testid="video-card-link-chips"]', all('[data-testid="video-card"]')[0]!);
    expect(text(chips)).toContain("Smith family · Active"); expect(text(chips)).toContain("Jones · Expired"); expect(text(chips)).not.toContain("Wu"); expect(text(chips)).toContain("+1");
    expect(q('[data-testid="video-card-link-chips"]', all('[data-testid="video-card"]')[1]!)).toBeNull();
    await press(buttonIn(chips, /Smith family/));
    expect(q('[data-testid="review-link-detail"]')).not.toBeNull();
    expect(text(dialog())).toContain("Smith family");
  });
});

describe("create", () => {
  it("ticking Videos shows a bar with the count; Clear empties it", async () => {
    await mount();
    expect(q('[data-testid="review-link-selection-bar"]')).toBeNull();
    await selectFilms("Main walkthrough", "Teaser");
    const bar = q('[data-testid="review-link-selection-bar"]')!;
    expect(bar.getAttribute("data-surface")).toBe("inverse");
    expect(text(bar)).toContain("2 selected");
    await press(buttonIn(bar, "Clear"));
    expect(q('[data-testid="review-link-selection-bar"]')).toBeNull();
    expect(checkbox("Select Teaser")!.checked).toBe(false);
  });
  it("opens with a 30-day expiry, the current Version preselected, and the last Version locked", async () => {
    await mount(); await selectFilms("Main walkthrough");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    const d = dialog()!;
    expect(text(d)).toContain("Create Review link");
    expect(text(q("button#review-link-expiry", d))).toContain("9 Nov 2026");
    expect(checkbox("Main walkthrough v2", d)!.checked).toBe(true);
    expect(checkbox("Main walkthrough v1", d)!.checked).toBe(false);
    expect(checkbox("Main walkthrough v2", d)!.disabled).toBe(true);
    await press(checkbox("Main walkthrough v1", d));
    expect(checkbox("Main walkthrough v2", d)!.disabled).toBe(false);
    expect(toggle("Comments", d)!.getAttribute("aria-checked")).toBe("true");
  });
  it("sends exactly what was chosen: Videos, Versions, end-of-day expiry, label, passcode, permissions", async () => {
    apiPostMock.mockResolvedValue({ link: linkOf(), url: `https://quincy.test/d/review?link=${L1}#t=tok123` });
    await mount(); await selectFilms("Main walkthrough", "Teaser");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    const d = dialog()!;
    await type(q<HTMLInputElement>("#review-link-label", d), "Smith family");
    await type(q<HTMLInputElement>("#review-link-passcode", d), "  hunter22 ");
    await press(checkbox("Main walkthrough v1", d));
    await press(toggle("Download", d));
    await press(q("button#review-link-expiry", d)); // the date popup
    await press(all<HTMLButtonElement>("button", document).find((b) => b.textContent?.startsWith("Tomorrow")));
    await press(all<HTMLButtonElement>("button", document).find((b) => b.textContent === "Apply"));
    await press(buttonIn(d, "Create link"));
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    const [path, body] = apiPostMock.mock.calls[0]!;
    expect(path).toBe(`/api/projects/${PROJECT}/review-links`);
    expect(body).toEqual({ videoIds: [V1, V2], grants: { [V1]: [A2, A1], [V2]: [B1] }, expiresAt: "2026-10-11T12:59:00.000Z", label: "Smith family", passcode: "hunter22", allow: { comments: true, approve: true, download: false } });
  });
  it("leaves label and passcode out when blank, and refuses a short passcode before sending", async () => {
    apiPostMock.mockResolvedValue({ link: linkOf(), url: `https://quincy.test/d/review?link=${L1}#t=tok123` });
    await mount(); await selectFilms("Teaser");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    const d = dialog()!;
    await type(q<HTMLInputElement>("#review-link-passcode", d), "abc");
    expect(text(d)).toContain("6 to 64 characters");
    expect(buttonIn(d, "Create link")!.disabled).toBe(true);
    await type(q<HTMLInputElement>("#review-link-passcode", d), "");
    await press(buttonIn(d, "Create link"));
    const body = apiPostMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("label"); expect(body).not.toHaveProperty("passcode");
    expect(body.videoIds).toEqual([V2]);
  });
  it("keeps the draft and the ticks through Cancel and a reopen, and through a list refresh", async () => {
    await mount(); await selectFilms("Main walkthrough");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    await type(q<HTMLInputElement>("#review-link-label", dialog()), "Draft name");
    await type(q<HTMLInputElement>("#review-link-passcode", dialog()), "secret-1");
    await press(buttonIn(dialog(), "Cancel"));
    expect(dialog()).toBeNull();
    expect(checkbox("Select Main walkthrough")!.checked).toBe(true);
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    expect(q<HTMLInputElement>("#review-link-label", dialog())!.value).toBe("Draft name");
    expect(q<HTMLInputElement>("#review-link-passcode", dialog())!.value).toBe("secret-1");
  });
  it("shows the URL once with a Copy button; copying writes the full link and announces it", async () => {
    const url = `https://quincy.test/d/review?link=${L1}#t=tok123`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    apiPostMock.mockResolvedValue({ link: linkOf(), url });
    state.links = [linkOf()];
    await mount(); await selectFilms("Main walkthrough");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    await press(buttonIn(dialog(), "Create link"));
    const reveal = q('[data-testid="review-link-reveal"]')!;
    expect(q<HTMLInputElement>('input[aria-label="Review link URL"]', reveal)!.value).toBe(url);
    expect(q<HTMLInputElement>('input[aria-label="Review link URL"]', reveal)!.readOnly).toBe(true);
    expect(text(reveal)).toContain("This is the only time the full link is shown. Lost it? Use Replace link.");
    expect(writeText).not.toHaveBeenCalled(); // no auto-copy
    await press(buttonIn(reveal, "Copy link"));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(live()).toContain("Link copied.");
    expect(text(buttonIn(reveal, /Copied/))).toContain("Copied");
  });
  it("announces a copy failure and never claims success", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    apiPostMock.mockResolvedValue({ link: linkOf(), url: `https://quincy.test/d/review?link=${L1}#t=tok123` });
    await mount(); await selectFilms("Teaser");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    await press(buttonIn(dialog(), "Create link"));
    await press(buttonIn(q('[data-testid="review-link-reveal"]'), "Copy link"));
    expect(live()).toContain("Couldn't copy the link.");
    expect(live()).not.toContain("Link copied.");
  });
  it("never stores the URL: not in storage, not in the query cache; Done discards it and clears the selection, and the list is refetched", async () => {
    const url = `https://quincy.test/d/review?link=${L1}#t=tok123`;
    apiPostMock.mockResolvedValue({ link: linkOf(), url });
    state.links = [linkOf()];
    await mount(); await selectFilms("Main walkthrough");
    const listCalls = () => apiGetMock.mock.calls.filter(([path]) => path.endsWith("/review-links")).length;
    const before = listCalls();
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    await press(buttonIn(dialog(), "Create link"));
    expect(listCalls()).toBeGreaterThan(before);
    const dump = (storage: Storage | undefined) => { try { return JSON.stringify({ ...storage }); } catch { return ""; } };
    const stored = dump(window.localStorage) + dump(window.sessionStorage);
    expect(stored).not.toContain("tok123");
    expect(q('[data-testid="video-card-grid"]')?.outerHTML).not.toContain("tok123");
    expect(q('[data-testid="review-link-selection-bar"]')).toBeNull();
    await press(buttonIn(q('[data-testid="review-link-reveal"]'), "Done"));
    expect(document.body.textContent).not.toContain("tok123");
    expect(q('input[aria-label="Review link URL"]')).toBeNull();
    expect(q('[data-testid="review-link-detail"]')).not.toBeNull();
  });
  it("a create that lands after the dialog was closed still shows its URL", async () => {
    let finish!: (value: unknown) => void;
    apiPostMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await mount(); await selectFilms("Teaser");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    await press(buttonIn(dialog(), "Create link"));
    expect(buttonIn(dialog(), /Creating/)!.disabled).toBe(true);
    await press(buttonIn(dialog(), "Close"));
    expect(dialog()).toBeNull();
    await act(async () => { finish({ link: linkOf(), url: `https://quincy.test/d/review?link=${L1}#t=late` }); });
    await flush();
    expect(q<HTMLInputElement>('input[aria-label="Review link URL"]')?.value).toContain("#t=late");
  });
  it.each([
    ["grant_not_version", 422, /no longer belongs to this Video/],
    ["expiry_out_of_range", 422, /between one hour and 365 days/],
    ["video_other_project", 422, /this Project/],
    ["project_archived", 409, /Archived projects are read-only/],
  ])("shows the %s refusal in the dialog and keeps the form", async (code, status, copy) => {
    apiPostMock.mockRejectedValue(refused(status, { error: "server words", code }));
    await mount(); await selectFilms("Teaser");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    await type(q<HTMLInputElement>("#review-link-label", dialog()), "Keep me");
    await press(buttonIn(dialog(), "Create link"));
    expect(text(q('[role="alert"]', dialog() as ParentNode))).toMatch(copy);
    expect(q<HTMLInputElement>("#review-link-label", dialog())!.value).toBe("Keep me");
    expect(buttonIn(dialog(), "Create link")!.disabled).toBe(false);
  });
  it("says Review links are not available when the server answers gate-closed", async () => {
    apiPostMock.mockRejectedValue(refused(404, { error: "Not found" }));
    await mount(); await selectFilms("Teaser");
    await press(buttonIn(q('[data-testid="review-link-selection-bar"]'), "Create Review link"));
    await press(buttonIn(dialog(), "Create link"));
    expect(text(q('[role="alert"]', dialog() as ParentNode))).toMatch(/aren't available/);
  });
  it("on an archived Project there are no checkboxes, but the list is readable", async () => {
    state.links = [linkOf()];
    await mount({ archived: true });
    expect(checkbox("Select Main walkthrough")).toBeNull();
    await openList();
    expect(all('[data-testid="review-link-row"]')).toHaveLength(1);
  });
});
