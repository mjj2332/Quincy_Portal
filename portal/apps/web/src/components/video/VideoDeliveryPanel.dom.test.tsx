import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, VideoDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { QuincyQueryProvider } from "../../lib/query-client";
import { createVideoApprovalStore, type VideoApprovalStore } from "../../lib/video-approval-store";
import { VideoDeliveryPanel } from "./VideoDeliveryPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiDelete: vi.fn<(path: string) => Promise<unknown>>(),
}));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), ...api }));

const P = "11111111-1111-4111-8111-111111111111";
const V = "88888888-8888-4888-8888-888888888888";
const A2 = "77777777-7777-4777-8777-777777777777";
const A1 = "66666666-6666-4666-8666-666666666666";
const ME = "44444444-4444-4444-8444-444444444444";
const mia = { id: "99999999-9999-4999-8999-999999999999", name: "Mia Chen", roleLabel: "Editor", isExternal: false, active: true };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const guestEvent = (revision: number, decision: "approved" | "changes_requested", over: Record<string, unknown> = {}) => ({ id: uuid(), revision, decision, note: null, at: "2026-10-10T01:00:00.000Z", actor: { kind: "guest", name: "Sam Client" }, link: { id: uuid(), label: "Owner link" }, ...over });
const staffEvent = (revision: number, decision: "approved" | "changes_requested") => ({ id: uuid(), revision, decision, note: "phoned", at: "2026-10-10T02:00:00.000Z", actor: { kind: "user", person: mia }, link: null });
const release = (revision: number) => ({ id: uuid(), approvalRevision: revision, releasedAt: "2026-10-10T03:00:00.000Z", releasedBy: mia });
const videoOf = (over: Partial<VideoDto> = {}): VideoDto => ({ id: V, title: "Main walkthrough", premium: false, premiumUnlocked: false, position: 0, createdAt: "2026-10-09T01:00:00.000Z", currentAssetId: A2, latestNoteCount: null, uploading: null, versions: [{ assetId: A2, version: 2 }, { assetId: A1, version: 1 }], ...over }) as unknown as VideoDto;
let decisions: unknown;
const decide = (versions: Array<{ assetId: string; version: number; events: unknown[]; release: unknown }>) => { decisions = { versions }; };

let root: Root | null = null; let host: HTMLElement; let store: VideoApprovalStore;
async function flush(times = 6) { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); }
async function mount(props: { role?: Role; archived?: boolean; video?: VideoDto; assetId?: string } = {}) {
  const role = props.role ?? "editor";
  const video = props.video ?? videoOf();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const version = video.versions.find((v) => v.assetId === (props.assetId ?? A2))!;
  await act(async () => { root!.render(<QuincyQueryProvider principalId={ME} role={role}><VideoDeliveryPanel projectId={P} role={role} archived={props.archived ?? false} video={video} version={version} store={store} /></QuincyQueryProvider>); });
  await flush();
}
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const press = async (id: string) => { await act(async () => { byId(id)!.click(); }); await flush(2); };
const typeInto = async (id: string, value: string) => { const el = byId(id) as HTMLInputElement | HTMLTextAreaElement; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); }); };
const enabled = (id: string) => { const el = byId(id) as HTMLButtonElement | null; return el !== null && !el.disabled && el.getAttribute("aria-disabled") !== "true"; };

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  store = createVideoApprovalStore(`${ME}:${P}`);
  api.apiGet.mockImplementation(async () => decisions);
  decide([{ assetId: A2, version: 2, events: [], release: null }, { assetId: A1, version: 1, events: [guestEvent(1, "approved")], release: null }]);
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; store.retire(); document.body.replaceChildren(); });

describe("VideoDeliveryPanel decisions (#741 14-ui-staff)", () => {
  it("re-scopes its tokens to the light surface so it stays legible inside the viewer's inverse scope", async () => {
    decide([{ assetId: A2, version: 2, events: [], release: null }]);
    await mount();
    expect(document.querySelector('[data-testid="video-delivery"]')?.getAttribute("data-surface")).toBe("default");
  });

  it("lists the shown Version's decisions with who, what, when, the note and where they came from", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "changes_requested", { note: "Fix the title card" }), staffEvent(2, "approved")], release: null }, { assetId: A1, version: 1, events: [guestEvent(1, "approved", { actor: { kind: "guest", name: "Other Person" } })], release: null }]);
    await mount();
    const rows = [...document.querySelectorAll('[data-testid="delivery-decision"]')].map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows.join("|")).toContain("Sam Client");
    expect(rows.join("|")).toContain("Fix the title card");
    expect(rows.join("|")).toContain("Mia Chen");
    expect(rows.join("|")).toMatch(/recorded by staff/i);
    expect(rows.join("|")).not.toContain("Other Person");
    expect(byId("delivery-state")!.textContent).toMatch(/approved/i);
  });

  it("says plainly when the client has not decided", async () => {
    await mount();
    expect(byId("delivery-state")!.textContent).toMatch(/no client decision/i);
    expect(byId("delivery-empty")).not.toBeNull();
    expect(enabled("delivery-release")).toBe(false);
    expect(byId("delivery-release-reason")!.textContent).toMatch(/approval/i);
  });

  it("blocks Release while the latest decision asks for changes, even after an earlier approval", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved"), guestEvent(2, "changes_requested")], release: null }]);
    await mount();
    expect(byId("delivery-state")!.textContent).toMatch(/changes requested/i);
    expect(enabled("delivery-release")).toBe(false);
  });

  it("Release asks first, then sends the latest approval revision and re-reads the decisions", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "changes_requested"), guestEvent(2, "approved"), ], release: null }]);
    await mount();
    expect(enabled("delivery-release")).toBe(true);
    await press("delivery-release");
    expect(api.apiPost).not.toHaveBeenCalled();
    const reads = api.apiGet.mock.calls.length;
    api.apiPost.mockResolvedValue({ release: release(2) });
    await press("delivery-release-confirm");
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A2}/release`, { approvalRevision: 2 });
    expect(api.apiGet.mock.calls.length).toBeGreaterThan(reads);
  });

  it("sends one Release however many times it is pressed", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved")], release: null }]);
    await mount();
    await press("delivery-release");
    let finish!: (v: unknown) => void;
    api.apiPost.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await press("delivery-release-confirm");
    expect(enabled("delivery-release-confirm")).toBe(false);
    await act(async () => { byId("delivery-release-confirm")?.click(); });
    finish({ release: release(1) });
    await flush();
    expect(api.apiPost).toHaveBeenCalledTimes(1);
  });

  it("a stale Release says a newer decision arrived and reads the decisions again", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved")], release: null }]);
    await mount();
    await press("delivery-release");
    api.apiPost.mockRejectedValue(new ApiError("stale", 409, { code: "release_stale", current: 2 }));
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved"), guestEvent(2, "changes_requested")], release: null }]);
    const reads = api.apiGet.mock.calls.length;
    await press("delivery-release-confirm");
    await flush();
    expect(byId("delivery-version-problem")!.textContent).toMatch(/newer decision/i);
    expect(api.apiGet.mock.calls.length).toBeGreaterThan(reads);
    expect(byId("delivery-state")!.textContent).toMatch(/changes requested/i);
    expect(enabled("delivery-release")).toBe(false);
  });

  it("a Release the server calls not an approval explains why", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved")], release: null }]);
    await mount();
    await press("delivery-release");
    api.apiPost.mockRejectedValue(new ApiError("no", 422, { code: "not_approved" }));
    await press("delivery-release-confirm");
    expect(byId("delivery-version-problem")!.textContent).toMatch(/not an approval/i);
  });

  it("an archived Project reads as read-only after the server refuses, and the controls are off", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved")], release: null }]);
    await mount();
    await press("delivery-release");
    api.apiPost.mockRejectedValue(new ApiError("Archived", 409, { code: "project_archived" }));
    await press("delivery-release-confirm");
    expect(byId("delivery-version-problem")!.textContent).toMatch(/archived/i);
  });

  it("an archived Project shows everything read-only with the reason", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved")], release: null }]);
    await mount({ archived: true });
    expect(enabled("delivery-release")).toBe(false);
    expect(enabled("delivery-record-approved")).toBe(false);
    expect(byId("delivery-readonly")!.textContent).toMatch(/archived/i);
  });

  it("Withdraw replaces Release while the Version is released, and asks first", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved")], release: release(1) }]);
    await mount();
    expect(byId("delivery-state")!.textContent).toMatch(/released/i);
    expect(byId("delivery-release")).toBeNull();
    await press("delivery-withdraw");
    expect(api.apiDelete).not.toHaveBeenCalled();
    api.apiDelete.mockResolvedValue({ released: false });
    await press("delivery-withdraw-confirm");
    expect(api.apiDelete).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A2}/release`);
  });

  it("a Withdraw with nothing to withdraw says so", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved")], release: release(1) }]);
    await mount();
    await press("delivery-withdraw");
    api.apiDelete.mockRejectedValue(new ApiError("none", 404, { code: "no_live_release" }));
    await press("delivery-withdraw-confirm");
    expect(byId("delivery-version-problem")!.textContent).toMatch(/no live release/i);
  });

  it("records a client decision with an optional note, kept in the store while the dialog is closed", async () => {
    await mount();
    await press("delivery-record-approved");
    await typeInto("delivery-note", "Approved by phone");
    expect(store.getSlot(`version:${A2}`).note).toBe("Approved by phone");
    api.apiPost.mockResolvedValue({ decision: staffEvent(1, "approved") });
    await press("delivery-record-confirm");
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A2}/decisions`, { decision: "approved", note: "Approved by phone" });
    expect(store.getSlot(`version:${A2}`).note).toBe("");
  });

  it("records changes requested without a note by omitting it", async () => {
    await mount();
    await press("delivery-record-changes");
    api.apiPost.mockResolvedValue({ decision: staffEvent(1, "changes_requested") });
    await press("delivery-record-confirm");
    expect(api.apiPost).toHaveBeenCalledWith(`/api/projects/${P}/video-versions/${A2}/decisions`, { decision: "changes_requested" });
  });
});

describe("VideoDeliveryPanel premium (#741 14-ui-staff)", () => {
  it("an Editor sees premium but cannot change it, and is told why", async () => {
    await mount({ role: "editor", video: videoOf({ premium: true }) });
    expect(byId("delivery-premium-switch")!.getAttribute("aria-checked")).toBe("true");
    expect(enabled("delivery-premium-switch")).toBe(false);
    expect(byId("delivery-premium-reason")!.textContent).toMatch(/admin/i);
    expect(byId("delivery-unlock")).toBeNull();
  });

  it("an Admin turns premium on with a PUT and the switch follows the server's answer", async () => {
    await mount({ role: "admin" });
    expect(enabled("delivery-premium-switch")).toBe(true);
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await press("delivery-premium-switch");
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${P}/videos/${V}/premium`, { premium: true });
    expect(byId("delivery-premium-switch")!.getAttribute("aria-checked")).toBe("false"); // still the prop until the Videos list is re-read
  });

  it("offers Unlock only on a premium Video, sends the optional payment reference, and clears it afterwards", async () => {
    await mount({ role: "admin", video: videoOf({ premium: true }) });
    expect(byId("delivery-lock-state")!.textContent).toMatch(/locked/i);
    await press("delivery-unlock");
    await typeInto("delivery-payment-ref", "INV-204");
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: true });
    await press("delivery-unlock-confirm");
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${P}/videos/${V}/premium-unlock`, { unlocked: true, paymentRef: "INV-204" });
    expect(store.getSlot(`video:${V}`).paymentRef).toBe("");
  });

  it("Unlock with no reference omits it", async () => {
    await mount({ role: "admin", video: videoOf({ premium: true }) });
    await press("delivery-unlock");
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: true });
    await press("delivery-unlock-confirm");
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${P}/videos/${V}/premium-unlock`, { unlocked: true });
  });

  it("an unlocked premium Video offers Re-lock, which asks first", async () => {
    await mount({ role: "admin", video: videoOf({ premium: true, premiumUnlocked: true }) });
    expect(byId("delivery-lock-state")!.textContent).toMatch(/unlocked/i);
    expect(byId("delivery-unlock")).toBeNull();
    await press("delivery-relock");
    expect(api.apiPut).not.toHaveBeenCalled();
    api.apiPut.mockResolvedValue({ premium: true, premiumUnlocked: false });
    await press("delivery-relock-confirm");
    expect(api.apiPut).toHaveBeenCalledWith(`/api/projects/${P}/videos/${V}/premium-unlock`, { unlocked: false });
  });

  it("an Admin's 403 refusal reads as lost access", async () => {
    await mount({ role: "admin" });
    api.apiPut.mockRejectedValue(new ApiError("Forbidden", 403));
    await press("delivery-premium-switch");
    expect(byId("delivery-premium-problem")!.textContent).toMatch(/no longer have access/i);
  });

  it("keeps a Version error and a premium error apart, each beside its own controls", async () => {
    decide([{ assetId: A2, version: 2, events: [guestEvent(1, "approved")], release: null }]);
    await mount({ role: "admin", video: videoOf({ premium: true }) });
    await press("delivery-release");
    api.apiPost.mockRejectedValue(new ApiError("stale", 409, { code: "release_stale", current: 2 }));
    await press("delivery-release-confirm");
    await press("delivery-unlock");
    api.apiPut.mockRejectedValue(new ApiError("offline", 0));
    await press("delivery-unlock-confirm");
    expect(byId("delivery-version-problem")!.textContent).toMatch(/newer decision/i);
    expect(byId("delivery-premium-problem")!.textContent).toMatch(/couldn't reach the server/i);
    expect(byId("delivery-premium")!.contains(byId("delivery-premium-problem"))).toBe(true);
    expect(byId("delivery-premium")!.contains(byId("delivery-version-problem"))).toBe(false);
    await press("delivery-unlock");
    expect(byId("delivery-premium-problem")).toBeNull();
    expect(byId("delivery-version-problem")).not.toBeNull();
  });

  it("an archived Project turns the premium controls off", async () => {
    await mount({ role: "admin", archived: true, video: videoOf({ premium: true }) });
    expect(enabled("delivery-premium-switch")).toBe(false);
    expect(enabled("delivery-unlock")).toBe(false);
  });
});

describe("VideoDeliveryPanel stale data (#741 14-ui-staff)", () => {
  it("warns, and offers Retry, when a refresh fails while old decisions are still shown", async () => {
    await mount();
    expect(byId("delivery-stale")).toBeNull();
    api.apiPost.mockResolvedValue({ decision: staffEvent(1, "approved") });
    api.apiGet.mockRejectedValue(new ApiError("Bad request", 400));
    await press("delivery-record-approved");
    await press("delivery-record-confirm");
    await flush();
    const notice = byId("delivery-stale");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("Couldn't refresh delivery status. What you see may be out of date.");
    expect(byId("delivery-state")).not.toBeNull();
    api.apiGet.mockImplementation(async () => decisions);
    await press("delivery-stale-retry");
    expect(byId("delivery-stale")).toBeNull();
  });
});
