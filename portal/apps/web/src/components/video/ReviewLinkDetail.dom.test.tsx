import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { A1, A2, B1, id, videoOf, L1, L2, NOW, PROJECT, V1, V2, TEASER, WALK, all, button, buttonIn, checkbox, dialog, flush, linkOf, member, mount, openDetailOf, openList, press, q, refused, state, text, toggle, type, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/**
 * #741 11b: the staff UI for client Review links, driven through the Video Collection the way a person meets it. The API is mocked at
 * `lib/api` (the wire shapes are `packages/shared/src/review-links.ts`); "now" is pinned with a fake `Date` only so Base UI's timers run.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ userId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: auth.userId, role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
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
  state.links = [linkOf()]; state.videos = [WALK, TEASER];
  for (const mock of [apiGetMock, apiPostMock, apiPatchMock, apiPutMock, apiDeleteMock]) mock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); document.body.replaceChildren(); vi.useRealTimers(); });

const base = `/api/projects/${PROJECT}/review-links/${L1}`;
const detail = () => q('[data-testid="review-link-detail"]')!;
const listCalls = () => apiGetMock.mock.calls.filter(([path]) => path.endsWith("/review-links")).length;
const confirm = async (open: string, confirmLabel: string) => { await press(buttonIn(detail(), open)); await press(buttonIn(q('[data-testid="review-link-confirm"]'), confirmLabel)); };
const THREE = videoOf(V1, "Main walkthrough", [[id(303), 3, true], [A2, 2, false], [A1, 1, false]]);
const hangList = () => apiGetMock.mockImplementation(async (path) => { if (path.endsWith("/review-links")) return new Promise(() => undefined); if (path.endsWith("/videos")) return { videos: state.videos }; throw new Error(path); });
const save = () => buttonIn(detail(), "Save changes")!;

describe("detail: Versions and Videos", () => {
  it("shows each member with its granted Versions ticked and an All links way back", async () => {
    await mount(); await openDetailOf("Smith family");
    expect(text(dialog())).toContain("Smith family");
    expect(checkbox("Main walkthrough v2", detail())!.checked).toBe(true);
    expect(checkbox("Main walkthrough v1", detail())!.checked).toBe(false);
    await press(buttonIn(detail(), "All links"));
    expect(all('[data-testid="review-link-row"]')).toHaveLength(1);
  });
  it("ticking a Version sends the full set, newest first, and refetches the list", async () => {
    apiPutMock.mockResolvedValue({ link: linkOf({ videos: [member(V1, "Main walkthrough", [[A2, 2], [A1, 1]])] }) });
    await mount(); await openDetailOf("Smith family");
    const before = listCalls();
    await press(checkbox("Main walkthrough v1", detail()));
    expect(apiPutMock).toHaveBeenCalledWith(`${base}/videos/${V1}/grants`, { assetIds: [A2, A1] });
    expect(listCalls()).toBeGreaterThan(before);
  });
  it("unticking sends the rest; the last granted Version cannot be unticked", async () => {
    state.links = [linkOf({ videos: [member(V1, "Main walkthrough", [[A2, 2], [A1, 1]])] })];
    apiPutMock.mockResolvedValue({ link: linkOf() });
    await mount(); await openDetailOf("Smith family");
    await press(checkbox("Main walkthrough v2", detail()));
    expect(apiPutMock).toHaveBeenCalledWith(`${base}/videos/${V1}/grants`, { assetIds: [A1] });
    await unmount();
    state.links = [linkOf({ videos: [member(V1, "Main walkthrough", [[A1, 1]])] })];
    await mount(); await openDetailOf("Smith family");
    expect(checkbox("Main walkthrough v1", detail())!.disabled).toBe(true);
    expect(text(detail())).toContain("Remove the Video to stop sharing it");
  });
  it("Remove asks first: Cancel sends nothing, Remove Video deletes the membership", async () => {
    apiDeleteMock.mockResolvedValue(undefined);
    await mount(); await openDetailOf("Smith family");
    await press(buttonIn(detail(), "Remove Main walkthrough from link"));
    expect(text(q('[data-testid="review-link-confirm"]'))).toContain("Notes and decisions stay");
    await press(buttonIn(q('[data-testid="review-link-confirm"]'), "Cancel"));
    expect(apiDeleteMock).not.toHaveBeenCalled();
    await confirm("Remove Main walkthrough from link", "Remove Video");
    expect(apiDeleteMock).toHaveBeenCalledWith(`${base}/videos/${V1}`);
  });
  it("Add a Video offers only Videos not on the link, adds the current Version, and refetches", async () => {
    apiPostMock.mockResolvedValue({ link: linkOf() });
    await mount(); await openDetailOf("Smith family");
    await press(button("Add a Video"));
    const options = all('[role="option"]');
    expect(options.map((o) => o.textContent)).toEqual(["Teaser"]);
    await press(options[0]);
    expect(apiPostMock).toHaveBeenCalledWith(`${base}/videos`, { videoId: V2, assetIds: [B1] });
  });
  it("says every film is on the link when there is nothing to add", async () => {
    state.links = [linkOf({ videos: [member(V1, "Main walkthrough", [[A2, 2]]), member(V2, "Teaser", [[B1, 1]])] })];
    await mount(); await openDetailOf("Smith family");
    expect(button("Add a Video")).toBeUndefined();
    expect(text(detail())).toContain("Every film is on this link.");
  });
  it("lists verified guests when there are some, and nothing when there are none", async () => {
    await mount(); await openDetailOf("Smith family");
    expect(text(detail())).not.toContain("Verified guests");
    await unmount();
    state.links = [linkOf({ activity: { openSessions: 1, lastOpenedAt: "2026-10-10T02:00:00.000Z", verifiedGuests: [{ email: "client@example.com", lastSeenAt: "2026-10-10T02:30:00.000Z", unsubscribed: false }, { email: "quiet@example.com", lastSeenAt: "2026-10-09T02:30:00.000Z", unsubscribed: true }] } })];
    await mount(); await openDetailOf("Smith family");
    expect(text(detail())).toContain("Verified guests"); expect(text(detail())).toContain("client@example.com"); expect(text(detail())).toContain("Unsubscribed");
  });
});

describe("detail: settings", () => {
  it("Save is off until something changes, then sends only what changed", async () => {
    apiPatchMock.mockResolvedValue({ link: linkOf() });
    await mount(); await openDetailOf("Smith family");
    expect(save().disabled).toBe(true);
    await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "Smith family (final)");
    await press(toggle("Download", detail()));
    expect(save().disabled).toBe(false);
    await press(save());
    expect(apiPatchMock).toHaveBeenCalledWith(base, { label: "Smith family (final)", allow: { download: false } });
  });
  it("a new expiry day goes as the end of that day", async () => {
    apiPatchMock.mockResolvedValue({ link: linkOf() });
    await mount(); await openDetailOf("Smith family");
    await press(q("button#review-link-detail-expiry", detail()));
    await press(all<HTMLButtonElement>("button", document).find((b) => b.textContent?.startsWith("Tomorrow")));
    await press(all<HTMLButtonElement>("button", document).find((b) => b.textContent === "Apply"));
    await press(save());
    expect(apiPatchMock).toHaveBeenCalledWith(base, { expiresAt: "2026-10-11T12:59:00.000Z" });
  });
  it("clearing the label sends null; a passcode set is never shown, only that one exists, and Remove passcode sends null", async () => {
    state.links = [linkOf({ hasPasscode: true })];
    apiPatchMock.mockResolvedValue({ link: linkOf() });
    await mount(); await openDetailOf("Smith family");
    expect(text(detail())).toContain("A passcode is set.");
    expect(q<HTMLInputElement>("#review-link-detail-passcode", detail())!.value).toBe("");
    await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "");
    await press(buttonIn(detail(), "Remove passcode"));
    expect(text(detail())).toContain("passcode will be removed");
    await press(save());
    expect(apiPatchMock).toHaveBeenCalledWith(base, { label: null, passcode: null });
  });
  it("sets a new passcode (6 to 64 characters) and refuses a short one before sending", async () => {
    apiPatchMock.mockResolvedValue({ link: linkOf() });
    await mount(); await openDetailOf("Smith family");
    await type(q<HTMLInputElement>("#review-link-detail-passcode", detail()), "abc");
    expect(text(detail())).toContain("6 to 64 characters");
    expect(save().disabled).toBe(true);
    await type(q<HTMLInputElement>("#review-link-detail-passcode", detail()), "fresh-code");
    await press(save());
    expect(apiPatchMock).toHaveBeenCalledWith(base, { passcode: "fresh-code" });
  });
  it("keeps unsaved edits when the person goes back to the list and returns, and clears them after a save", async () => {
    apiPatchMock.mockResolvedValue({ link: linkOf() });
    await mount(); await openDetailOf("Smith family");
    await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "Half typed");
    await press(buttonIn(detail(), "All links")); await press(button("Manage Smith family"));
    expect(q<HTMLInputElement>("#review-link-detail-label", detail())!.value).toBe("Half typed");
    await press(save());
    expect(q<HTMLInputElement>("#review-link-detail-label", detail())!.value).toBe("Smith family");
    expect(save().disabled).toBe(true);
  });
  it("a double press on Save sends once", async () => {
    let finish!: (value: unknown) => void;
    apiPatchMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await mount(); await openDetailOf("Smith family");
    await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "Once");
    await press(save()); await press(buttonIn(detail(), /Saving/));
    expect(apiPatchMock).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ link: linkOf() }); }); await flush();
  });
});

describe("detail: revoke and replace", () => {
  it("Revoke asks first, posts, and the refetched list shows it revoked with every control off", async () => {
    apiPostMock.mockImplementation(async () => { state.links = [linkOf({ status: "revoked", revokedAt: "2026-10-10T03:00:00.000Z" })]; return { link: state.links[0] }; });
    await mount(); await openDetailOf("Smith family");
    await press(buttonIn(detail(), "Revoke link"));
    await press(buttonIn(q('[data-testid="review-link-confirm"]'), "Cancel"));
    expect(apiPostMock).not.toHaveBeenCalled();
    await confirm("Revoke link", "Revoke");
    expect(apiPostMock).toHaveBeenCalledWith(`${base}/revoke`, {});
    expect(text(detail())).toContain("Revoked");
    expect(text(detail())).toContain("can no longer open it");
    expect(buttonIn(detail(), "Revoke link")).toBeUndefined();
    expect(buttonIn(detail(), "Replace link")).toBeUndefined();
    expect(q<HTMLInputElement>("#review-link-detail-label", detail())!.disabled).toBe(true);
    expect(checkbox("Main walkthrough v2", detail())!.disabled).toBe(true);
    expect(buttonIn(detail(), "Remove Main walkthrough from link")).toBeUndefined();
  });
  it("Replace asks first, then shows the new URL once", async () => {
    const url = `https://quincy.test/d/review?link=${L1}#t=fresh456`;
    apiPostMock.mockResolvedValue({ link: linkOf(), url });
    await mount(); await openDetailOf("Smith family");
    await press(buttonIn(detail(), "Replace link"));
    expect(text(q('[data-testid="review-link-confirm"]'))).toContain("stops working at once");
    await press(buttonIn(q('[data-testid="review-link-confirm"]'), "Replace"));
    expect(apiPostMock).toHaveBeenCalledWith(`${base}/replace`, {});
    expect(q<HTMLInputElement>('input[aria-label="Review link URL"]')!.value).toBe(url);
    await press(buttonIn(q('[data-testid="review-link-reveal"]'), "Done"));
    expect(document.body.textContent).not.toContain("fresh456");
    expect(q('[data-testid="review-link-detail"]')).not.toBeNull();
  });
  it("an expired link cannot be replaced until its expiry is extended, but the expiry stays editable", async () => {
    state.links = [linkOf({ status: "expired", expiresAt: "2026-10-01T12:59:00.000Z" })];
    await mount(); await openDetailOf("Smith family");
    expect(buttonIn(detail(), "Replace link")!.disabled).toBe(true);
    expect(text(detail())).toContain("Extend the expiry");
    expect(q<HTMLButtonElement>("button#review-link-detail-expiry", detail())!.disabled).toBe(false);
  });
});

describe("detail: refusals", () => {
  it.each([
    ["PATCH link_revoked", () => apiPatchMock.mockRejectedValue(refused(409, { error: "x", code: "link_revoked" })), async () => { await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "x"); await press(save()); }, /was revoked/],
    ["PUT grant_required", () => apiPutMock.mockRejectedValue(refused(422, { error: "x", code: "grant_required" })), async () => { await press(checkbox("Main walkthrough v1", detail())); }, /at least one Version/],
    ["PUT grant_not_version", () => apiPutMock.mockRejectedValue(refused(422, { error: "x", code: "grant_not_version" })), async () => { await press(checkbox("Main walkthrough v1", detail())); }, /no longer belongs/],
    ["replace link_expired", () => apiPostMock.mockRejectedValue(refused(409, { error: "x", code: "link_expired" })), async () => { await confirm("Replace link", "Replace"); }, /has expired/],
    ["POST already_on_link", () => apiPostMock.mockRejectedValue(refused(409, { error: "x", code: "already_on_link" })), async () => { await press(button("Add a Video")); await press(all('[role="option"]')[0]); }, /already on this link/],
    ["DELETE link gone", () => apiDeleteMock.mockRejectedValue(refused(404, { error: "Review link not found" })), async () => { await confirm("Remove Main walkthrough from link", "Remove Video"); }, /no longer exists/],
    ["PATCH project_archived", () => apiPatchMock.mockRejectedValue(refused(409, { error: "x", code: "project_archived" })), async () => { await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "x"); await press(save()); }, /Archived projects are read-only/],
    ["PATCH expiry_out_of_range", () => apiPatchMock.mockRejectedValue(refused(422, { error: "x", code: "expiry_out_of_range" })), async () => { await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "x"); await press(save()); }, /between one hour/],
  ])("%s is shown in the detail and the list is refetched", async (_name, arrange, act_, copy) => {
    arrange();
    await mount(); await openDetailOf("Smith family");
    const before = listCalls();
    await act_();
    expect(text(q('[role="alert"]', detail()))).toMatch(copy);
    expect(listCalls()).toBeGreaterThan(before);
  });
  it("keeps what was typed after a refused save", async () => {
    apiPatchMock.mockRejectedValue(refused(409, { error: "x", code: "link_conflict" }));
    await mount(); await openDetailOf("Smith family");
    await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "Keep this");
    await press(save());
    expect(q<HTMLInputElement>("#review-link-detail-label", detail())!.value).toBe("Keep this");
  });
});

describe("archived Project", () => {
  it("is read-only apart from Revoke: inputs, switches, Versions, Add and Replace are off, with a notice", async () => {
    apiPostMock.mockResolvedValue({ link: linkOf({ status: "revoked" }) });
    await mount({ archived: true }); await openDetailOf("Smith family");
    expect(text(detail())).toContain("read-only");
    expect(q<HTMLInputElement>("#review-link-detail-label", detail())!.disabled).toBe(true);
    expect(toggle("Comments", detail())!.hasAttribute("data-disabled")).toBe(true);
    expect(checkbox("Main walkthrough v2", detail())!.disabled).toBe(true);
    expect(buttonIn(detail(), "Replace link")!.disabled).toBe(true);
    expect(buttonIn(detail(), "Remove Main walkthrough from link")).toBeUndefined();
    expect(button("Add a Video")).toBeUndefined();
    expect(buttonIn(detail(), "Revoke link")!.disabled).toBe(false);
    await confirm("Revoke link", "Revoke");
    expect(apiPostMock).toHaveBeenCalledWith(`${base}/revoke`, {});
  });
});

describe("phone width (390px): the responsive hooks", () => {
  // happy-dom has no layout, so this pins the classes and structure that make 390px work; the measurement is the browser pass.
  it("the dialog scrolls inside the viewport and every action is a tall, wrapping target", async () => {
    await mount(); await openList();
    const content = dialog()!;
    expect(content.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(content.className).toContain("overflow-y-auto");
    await press(button("Manage Smith family"));
    expect(q('[data-testid="review-link-actions"]', detail())!.className).toContain("flex-wrap");
    for (const name of ["Replace link", "Revoke link", "All links"]) expect(buttonIn(detail(), name)!.className, name).toMatch(/min-h-11|min-h-\[44px\]/);
    expect(checkbox("Main walkthrough v2", detail())!.closest("label")!.className).toMatch(/min-h-11|min-h-\[44px\]/);
  });
  it("the selection bar and the reveal stay inside the viewport", async () => {
    await mount();
    await press(checkbox("Select Teaser"));
    expect(q('[data-testid="review-link-selection-bar"]')!.className).toContain("max-w-[calc(100vw-2*var(--space-4))]");
    expect(q('[data-testid="review-link-selection-bar"]')!.className).toContain("flex-wrap");
  });
});

describe("a write's own answer is the truth until the refetch lands", () => {
  const V3 = id(303);
  it("grants chain on the returned link, not on a stale list: v3, then v2, then v1 sends [v3,v2,v1] while the GET is pending", async () => {
    state.videos = [THREE, TEASER];
    state.links = [linkOf({ videos: [member(V1, "Main walkthrough", [[V3, 3]])] })];
    apiPutMock.mockImplementationOnce(async () => ({ link: linkOf({ videos: [member(V1, "Main walkthrough", [[V3, 3], [A2, 2]])] }) }));
    apiPutMock.mockImplementationOnce(async () => ({ link: linkOf({ videos: [member(V1, "Main walkthrough", [[V3, 3], [A2, 2], [A1, 1]])] }) }));
    await mount(); await openDetailOf("Smith family");
    hangList();
    await press(checkbox("Main walkthrough v2", detail()));
    expect(apiPutMock).toHaveBeenNthCalledWith(1, `${base}/videos/${V1}/grants`, { assetIds: [V3, A2] });
    expect(checkbox("Main walkthrough v2", detail())!.checked).toBe(true);
    await press(checkbox("Main walkthrough v1", detail()));
    expect(apiPutMock).toHaveBeenNthCalledWith(2, `${base}/videos/${V1}/grants`, { assetIds: [V3, A2, A1] });
  });
  it("the Version boxes stay locked until the answer is in the list", async () => {
    state.videos = [THREE, TEASER];
    state.links = [linkOf({ videos: [member(V1, "Main walkthrough", [[V3, 3]])] })];
    let answer!: (value: unknown) => void;
    apiPutMock.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    await mount(); await openDetailOf("Smith family");
    hangList();
    await press(checkbox("Main walkthrough v2", detail()));
    expect(checkbox("Main walkthrough v1", detail())!.disabled).toBe(true);
    await act(async () => { answer({ link: linkOf({ videos: [member(V1, "Main walkthrough", [[V3, 3], [A2, 2]])] }) }); });
    await flush();
    expect(checkbox("Main walkthrough v1", detail())!.disabled).toBe(false);
    expect(checkbox("Main walkthrough v2", detail())!.checked).toBe(true);
  });
  it("Remove Video drops the member at once", async () => {
    state.links = [linkOf({ videos: [member(V1, "Main walkthrough", [[A2, 2]]), member(V2, "Teaser", [[B1, 1]])] })];
    apiDeleteMock.mockResolvedValue(undefined);
    await mount(); await openDetailOf("Smith family");
    hangList();
    await confirm("Remove Teaser from link", "Remove Video");
    expect(all('[data-testid="review-link-member"]')).toHaveLength(1);
    expect(text(detail())).not.toContain("Teaser");
  });
  it("Add a Video shows the new member at once", async () => {
    apiPostMock.mockResolvedValue({ link: linkOf({ videos: [member(V1, "Main walkthrough", [[A2, 2]]), member(V2, "Teaser", [[B1, 1]])] }) });
    await mount(); await openDetailOf("Smith family");
    hangList();
    await press(button("Add a Video")); await press(all('[role="option"]')[0]);
    expect(all('[data-testid="review-link-member"]')).toHaveLength(2);
  });
  it("Save shows the new label at once; Revoke shows Revoked at once", async () => {
    apiPatchMock.mockResolvedValue({ link: linkOf({ label: "Renamed" }) });
    apiPostMock.mockResolvedValue({ link: linkOf({ label: "Renamed", status: "revoked", revokedAt: "2026-10-10T03:00:00.000Z" }) });
    await mount(); await openDetailOf("Smith family");
    hangList();
    await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "Renamed");
    await press(save());
    expect(q<HTMLInputElement>("#review-link-detail-label", detail())!.value).toBe("Renamed");
    expect(save().disabled).toBe(true);
    await confirm("Revoke link", "Revoke");
    expect(text(detail())).toContain("Revoked");
    expect(buttonIn(detail(), "Revoke link")).toBeUndefined();
  });
  it("a successful Save keeps a passcode typed while the request was out", async () => {
    let answer!: (value: unknown) => void;
    apiPatchMock.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    await mount(); await openDetailOf("Smith family");
    await type(q<HTMLInputElement>("#review-link-detail-label", detail()), "Renamed");
    await press(save());
    await type(q<HTMLInputElement>("#review-link-detail-passcode", detail()), "typed-meanwhile");
    await act(async () => { answer({ link: linkOf({ label: "Renamed" }) }); });
    await flush();
    expect(q<HTMLInputElement>("#review-link-detail-passcode", detail())!.value).toBe("typed-meanwhile");
    expect(save().disabled).toBe(false);
  });
});
