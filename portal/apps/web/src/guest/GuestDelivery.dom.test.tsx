import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestDownloadManifest, GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { GuestApp } from "./GuestApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}`;
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const vid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const allow = (over: Partial<GuestSessionResponse["link"]["allow"]> = {}) => ({ comments: true, approve: true, download: true, markup: true, ...over });
const sessionOf = (over: { verified?: boolean; allow?: Partial<GuestSessionResponse["link"]["allow"]> } = {}): GuestSessionResponse => ({
  link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: allow(over.allow) },
  verified: over.verified ?? true, email: over.verified === false ? null : "sam@example.com", name: over.verified === false ? null : "Sam", notifications: null, media: { heic: false },
});
const decisionOf = (value: "approved" | "changes_requested", revision = 1) => ({ value, revision, at: "2026-10-10T01:00:00.000Z", self: true });

const versionOf = (n: number, over: Record<string, unknown> = {}) => ({
  assetId: asset(n), version: n, fps: { num: 25, den: 1 }, frameCount: 3000, durationMs: 120000, width: 1920, height: 1080, startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false,
  hasAudio: true, posterUrl: `${BASE}/versions/${asset(n)}/poster`, streamUrl: `${BASE}/versions/${asset(n)}/stream`, publicNoteCount: 0, decision: null, released: false, downloadUrl: null, ...over,
});
const videoOf = (n: number, versions: ReturnType<typeof versionOf>[] = [versionOf(n * 10)], over: Partial<GuestVideoDto> = {}): GuestVideoDto => ({ id: vid(n), title: `Film ${n}`, premium: false, unlocked: true, versions: versions as GuestVideoDto["versions"], ...over });
const downloadUrl = (assetId: string) => `${BASE}/versions/${assetId}/download`;

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response | undefined> | undefined;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const stub404 = () => new Response("Not found", { status: 404 });

let session: GuestSessionResponse;
let videos: GuestVideoDto[];
let manifest: GuestDownloadManifest | Response;
let extra: Handler | null;
let fetchMock: ReturnType<typeof vi.fn>;
let stub: VideoElementStub;
let viewport: MockViewport;
let root: Root | null = null;
let host: HTMLElement;

async function route(url: string, init: RequestInit | undefined): Promise<Response> {
  const custom = await extra?.(url, init);
  if (custom) return custom;
  if (url === `${BASE}/session`) return json(session);
  if (url === `${BASE}/videos`) return json({ videos });
  if (url === `${BASE}/downloads`) return manifest instanceof Response ? manifest.clone() : json(manifest);
  if (/\/versions\/[^/]+\/notes$/.test(url) && (init?.method ?? "GET") === "GET") return json({ notes: [] });
  return stub404();
}

const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
async function open() {
  window.history.replaceState(null, "", `/d/review?link=${LINK}#t=tok123`);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<GuestApp token="tok123" />); });
  await flush();
}
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allById = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const typeInto = async (element: HTMLElement | null, value: string) => {
  const field = element as HTMLInputElement | HTMLTextAreaElement;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
};
const submit = async (id: string) => { await act(async () => { byId(id)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await flush(); };
const posts = () => fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST" && String(call[0]) !== `${BASE}/session`)
  .map((call) => ({ url: String(call[0]), body: JSON.parse(String((call[1] as RequestInit).body)) as unknown }));
const gets = (url: string) => fetchMock.mock.calls.filter((call) => String(call[0]) === url && ((call[1] as RequestInit | undefined)?.method ?? "GET") === "GET").length;
const decisionUrl = (assetId: string) => `${BASE}/versions/${assetId}/decision`;
const chipText = () => allById("guest-decision-chip").map((chip) => chip.textContent?.trim());
async function chooseVersion(prefix: string) {
  await click(byId("guest-version-trigger"));
  await click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.startsWith(prefix)));
}

/** Walks the verify dialog through to a verified session (the verify route answers with it). */
async function completeVerify() {
  extra = (url, init) => {
    if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
    if (url === `${BASE}/email/verify` && init?.method === "POST") { session = sessionOf(); return json(session); }
    return undefined;
  };
  await typeInto(byId("guest-verify-email"), "sam@example.com");
  await typeInto(byId("guest-verify-name"), "Sam");
  await submit("guest-verify-identity-form");
  await typeInto(byId("guest-verify-code"), "123456");
  await flush();
}

beforeEach(() => {
  stub = installVideoElementStub();
  viewport = mockViewport({ width: 1440 });
  session = sessionOf(); videos = [videoOf(1)]; manifest = { included: [], leftOut: [], totalBytes: 0, tooLarge: false, archive: { state: "ready", pending: 0 } }; extra = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("Approve and Request changes", () => {
  it("are offered only when the link allows approving", async () => {
    session = sessionOf({ allow: { approve: false } });
    await open();
    expect(byId("guest-approve")).toBeNull();
    expect(byId("guest-request-changes")).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; host.remove(); document.body.innerHTML = "";
    session = sessionOf();
    await open();
    expect(byId("guest-approve")).not.toBeNull();
    expect(byId("guest-request-changes")).not.toBeNull();
  });

  it("Approve confirms first, then posts the decision for the shown Version with no note", async () => {
    extra = (url, init) => (url === decisionUrl(asset(10)) && init?.method === "POST" ? json({ decision: decisionOf("approved") }, 201) : undefined);
    await open();
    await click(byId("guest-approve"));
    expect(byId("guest-decision-dialog")).not.toBeNull();
    expect(posts()).toEqual([]);
    await click(byId("guest-decision-confirm"));
    expect(posts()).toEqual([{ url: decisionUrl(asset(10)), body: { decision: "approved" } }]);
    expect(byId("guest-decision-dialog")).toBeNull();
    expect(chipText()).toEqual(["Approved"]);
  });

  it("labels the decision note with visible text", async () => {
    await open();
    await click(byId("guest-approve"));
    const note = byId("guest-decision-note") as HTMLTextAreaElement;
    const label = note.labels?.[0];
    expect(label?.textContent).toBe("Note for the studio (optional)");
    expect(note.getAttribute("aria-label")).toBeNull();
  });

  it("Request changes sends the optional note, trimmed", async () => {
    extra = (url, init) => (url === decisionUrl(asset(10)) && init?.method === "POST" ? json({ decision: decisionOf("changes_requested") }, 201) : undefined);
    await open();
    await click(byId("guest-request-changes"));
    await typeInto(byId("guest-decision-note"), "  Please shorten the intro  ");
    await click(byId("guest-decision-confirm"));
    expect(posts()).toEqual([{ url: decisionUrl(asset(10)), body: { decision: "changes_requested", note: "Please shorten the intro" } }]);
    expect(chipText()).toEqual(["Changes requested"]);
  });

  it("Cancel posts nothing and keeps the typed note for the next time the dialog opens", async () => {
    await open();
    await click(byId("guest-request-changes"));
    await typeInto(byId("guest-decision-note"), "Draft thoughts");
    await click(byId("guest-decision-cancel"));
    expect(byId("guest-decision-dialog")).toBeNull();
    expect(posts()).toEqual([]);
    await click(byId("guest-request-changes"));
    expect((byId("guest-decision-note") as HTMLTextAreaElement).value).toBe("Draft thoughts");
  });

  it("sends one decision when Confirm is pressed twice while the first is out", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    extra = async (url, init) => { if (url === decisionUrl(asset(10)) && init?.method === "POST") { await gate; return json({ decision: decisionOf("approved") }, 201); } return undefined; };
    await open();
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    await click(byId("guest-decision-confirm"));
    expect(posts()).toHaveLength(1);
    await act(async () => { release(); });
    await flush();
    expect(chipText()).toEqual(["Approved"]);
  });

  it("an unverified guest is taken to the verify dialog first, and lands on the confirm after the code", async () => {
    session = sessionOf({ verified: false });
    extra = (url, init) => {
      if (url === `${BASE}/email/code` && init?.method === "POST") return json({ sent: true, resendAfterSeconds: 60 }, 202);
      if (url === `${BASE}/email/verify` && init?.method === "POST") { session = sessionOf(); return json(session); }
      return undefined;
    };
    await open();
    await click(byId("guest-approve"));
    expect(byId("guest-verify-dialog")).not.toBeNull();
    // One dialog serves every action, so its title names the step, not "Add a note".
    expect(byId("guest-verify-dialog")!.querySelector("h2")?.textContent).toBe("Verify your email");
    expect(byId("guest-decision-dialog")).toBeNull();
    await typeInto(byId("guest-verify-email"), "sam@example.com");
    await typeInto(byId("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    await typeInto(byId("guest-verify-code"), "123456");
    await flush();
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(byId("guest-decision-dialog")).not.toBeNull();
    expect(posts().map((call) => call.url)).not.toContain(decisionUrl(asset(10)));
  });

  describe("refusals", () => {
    const refuse = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (url, init) => (url === decisionUrl(asset(10)) && init?.method === "POST" ? json(body, status, headers) : undefined);
    const attempt = async (note = "") => {
      await open();
      await click(byId("guest-approve"));
      if (note) await typeInto(byId("guest-decision-note"), note);
      await click(byId("guest-decision-confirm"));
    };

    it("401 closes the confirm, opens the verify dialog and keeps the note", async () => {
      extra = refuse(401, { error: "verification_required" });
      await attempt("Looks great");
      expect(byId("guest-verify-dialog")).not.toBeNull();
      expect(byId("guest-decision-dialog")).toBeNull();
      expect(chipText()).toEqual([]);
    });

    it("409 decision_conflict keeps the dialog open with a retry message and re-reads the videos", async () => {
      extra = refuse(409, { error: "decision_conflict" });
      const before = gets(`${BASE}/videos`);
      await attempt();
      expect(byId("guest-decision-dialog")).not.toBeNull();
      expect(byId("guest-decision-problem")?.textContent).toMatch(/same moment|try again/i);
      expect(gets(`${BASE}/videos`)).toBeGreaterThan(before);
    });

    it("409 project_archived makes the page read-only and takes the decision controls away", async () => {
      extra = refuse(409, { error: "project_archived" });
      await attempt();
      expect(byId("guest-archived-notice")).not.toBeNull();
      expect(byId("guest-decision-dialog")).toBeNull();
      expect(byId("guest-approve")).toBeNull();
      expect(byId("guest-request-changes")).toBeNull();
    });

    it("404 is the unavailable page", async () => {
      extra = refuse(404, "Not found");
      await attempt();
      expect(byId("guest-unavailable")).not.toBeNull();
    });

    it("403 approve_disabled removes the controls and says why", async () => {
      extra = refuse(403, { error: "approve_disabled" });
      await attempt();
      expect(byId("guest-decision-dialog")).toBeNull();
      expect(byId("guest-approve")).toBeNull();
      expect(byId("guest-decision-notice")?.textContent).toMatch(/no longer/i);
    });

    it("429 says how long to wait and stays open", async () => {
      extra = refuse(429, { error: "too_many_attempts", retryAfterSeconds: 30 }, { "retry-after": "30" });
      await attempt();
      expect(byId("guest-decision-dialog")).not.toBeNull();
      expect(byId("guest-decision-problem")?.textContent).toMatch(/30 seconds/);
    });

    it("400 says the note could not be sent", async () => {
      extra = refuse(400, { error: "invalid_request" });
      await attempt();
      expect(byId("guest-decision-problem")?.textContent).toMatch(/couldn't be sent|check it/i);
    });

    it("a 5xx says it may not have been recorded, reads the videos again and shows a decision that did land", async () => {
      extra = (url, init) => {
        if (url !== decisionUrl(asset(10)) || init?.method !== "POST") return undefined;
        videos = [videoOf(1, [versionOf(10, { decision: decisionOf("approved") })])];
        return json({ error: "x" }, 503);
      };
      const before = gets(`${BASE}/videos`);
      await attempt();
      expect(byId("guest-decision-problem")?.textContent).toMatch(/may or may not/i);
      expect(gets(`${BASE}/videos`)).toBeGreaterThan(before);
      expect(chipText()).toEqual(["Approved"]);
    });
  });

  it("a completion that lands after the guest moved to another Version records on the Version it was sent for and leaves the new one alone", async () => {
    videos = [videoOf(1, [versionOf(20), versionOf(10)])];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    extra = async (url, init) => { if (url === decisionUrl(asset(20)) && init?.method === "POST") { await gate; return json({ decision: decisionOf("approved") }, 201); } return undefined; };
    await open();
    await click(byId("guest-approve"));
    await typeInto(byId("guest-decision-note"), "Sent for v20");
    await click(byId("guest-decision-confirm"));
    // The guest dismisses the dialog while the answer is out and goes to the older Version.
    await click(byId("guest-decision-cancel"));
    await chooseVersion("v10");
    await click(byId("guest-request-changes"));
    expect((byId("guest-decision-note") as HTMLTextAreaElement).value).toBe("");
    await act(async () => { release(); });
    await flush();
    // The v10 dialog is still the guest's, with no message and no chip, and nothing was posted for v10.
    expect(byId("guest-decision-dialog")).not.toBeNull();
    expect(byId("guest-decision-problem")).toBeNull();
    expect(chipText()).toEqual([]);
    expect(posts().map((call) => call.url)).toEqual([decisionUrl(asset(20))]);
    await click(byId("guest-decision-cancel"));
    await chooseVersion("v20");
    expect(chipText()).toEqual(["Approved"]);
  });

  it("a late 401 for an abandoned Approve does not replace the Request changes dialog the guest opened since, once they verify", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    extra = async (url, init) => { if (url === decisionUrl(asset(10)) && init?.method === "POST") { await gate; return json({ error: "verification_required" }, 401); } return undefined; };
    await open();
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    await click(byId("guest-decision-cancel"));
    await click(byId("guest-request-changes"));
    await typeInto(byId("guest-decision-note"), "Keep this note");
    await act(async () => { release(); });
    await flush();
    expect(byId("guest-verify-dialog")).not.toBeNull();
    await completeVerify();
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(byId("guest-decision-dialog")).not.toBeNull();
    expect((byId("guest-decision-note") as HTMLTextAreaElement).value).toBe("Keep this note");
  });

  const holdDecision401 = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    extra = async (url, init) => { if (url === decisionUrl(asset(10)) && init?.method === "POST") { await gate; return json({ error: "verification_required" }, 401); } return undefined; };
    return async () => { await act(async () => { release(); }); await flush(); };
  };
  const pressEscape = async () => { await act(async () => { (byId("guest-decision-dialog") ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); await flush(); };

  it("Approve, Cancel, a late 401, then verifying does not reopen the cancelled Approve", async () => {
    const lateAnswer = holdDecision401();
    await open();
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    await click(byId("guest-decision-cancel"));
    await lateAnswer();
    await completeVerify();
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(byId("guest-decision-dialog")).toBeNull();
  });

  it("Approve, Escape, a late 401, then verifying does not reopen the cancelled Approve", async () => {
    const lateAnswer = holdDecision401();
    await open();
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    await pressEscape();
    expect(byId("guest-decision-dialog")).toBeNull();
    await lateAnswer();
    await completeVerify();
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(byId("guest-decision-dialog")).toBeNull();
  });

  it("a Download all manifest 401 and a late decision 401 share one verify dialog, and verifying runs only the Download all continuation", async () => {
    videos = [videoOf(1), videoOf(2)];
    const lateAnswer = holdDecision401();
    manifest = json({ error: "verification_required" }, 401);
    await open();
    await click(allById("guest-video-row")[0]!.querySelector("button"));
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    await click(byId("guest-decision-cancel"));
    await click(byId("guest-download-all"));
    expect(allById("guest-verify-dialog")).toHaveLength(1);
    await lateAnswer();
    expect(allById("guest-verify-dialog")).toHaveLength(1);
    manifest = { included: [{ videoId: vid(1), title: "Film 1", version: 1, bytes: 5 }], leftOut: [], totalBytes: 5, tooLarge: false, archive: { state: "ready", pending: 0 } };
    const before = gets(`${BASE}/downloads`);
    await completeVerify();
    expect(allById("guest-verify-dialog")).toHaveLength(0);
    expect(byId("guest-decision-dialog")).toBeNull();
    expect(byId("guest-download-all-dialog")).not.toBeNull();
    expect(gets(`${BASE}/downloads`)).toBe(before + 1);
  });

  it("a delayed delivery re-read from an ambiguous Approve cannot put the Approved chip back over a newer Request changes", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let hold = false;
    extra = async (url, init) => {
      if (url === decisionUrl(asset(10)) && init?.method === "POST") {
        if (hold) return json({ decision: decisionOf("changes_requested", 2) }, 201);
        return json({ error: "x" }, 503);
      }
      if (url === `${BASE}/videos` && hold === false && init?.method === undefined && posts().length > 0) {
        // The re-read that follows the ambiguous Approve: it captured revision 1 and is slow to arrive.
        const stale = [videoOf(1, [versionOf(10, { decision: decisionOf("approved", 1) })])];
        hold = true;
        await gate;
        return json({ videos: stale });
      }
      return undefined;
    };
    await open();
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    expect(byId("guest-decision-problem")?.textContent).toMatch(/may or may not/i);
    await click(byId("guest-decision-cancel"));
    await click(byId("guest-request-changes"));
    await click(byId("guest-decision-confirm"));
    expect(chipText()).toEqual(["Changes requested"]);
    await act(async () => { release(); });
    await flush();
    expect(chipText()).toEqual(["Changes requested"]);
  });

  it("an Approve that completes after the guest opened Request changes on the same Version is applied without closing the new dialog", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    extra = async (url, init) => { if (url === decisionUrl(asset(10)) && init?.method === "POST") { await gate; return json({ decision: decisionOf("approved") }, 201); } return undefined; };
    await open();
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    await click(byId("guest-decision-cancel"));
    await click(byId("guest-request-changes"));
    expect(byId("guest-decision-dialog")).not.toBeNull();
    await act(async () => { release(); });
    await flush();
    expect(byId("guest-decision-dialog")).not.toBeNull();
    expect(chipText()).toEqual(["Approved"]);
  });

  it("a late Approve response (revision 1) cannot overwrite a newer revision 2 that a delivery refresh already showed", async () => {
    videos = [videoOf(1, [versionOf(20), versionOf(10)])];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    extra = async (url, init) => {
      if (init?.method !== "POST") return undefined;
      if (url === decisionUrl(asset(10))) { await gate; return json({ decision: decisionOf("approved", 1) }, 201); }
      if (url === decisionUrl(asset(20))) {
        // Another guest requested changes on v10 (revision 2) while this Approve was out; this unrelated answer is ambiguous, so the page re-reads and sees revision 2.
        videos = [videoOf(1, [versionOf(20), versionOf(10, { decision: decisionOf("changes_requested", 2) })])];
        return json({ error: "x" }, 503);
      }
      return undefined;
    };
    await open();
    await chooseVersion("v10");
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    await click(byId("guest-decision-cancel"));
    await chooseVersion("v20");
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    await click(byId("guest-decision-cancel"));
    await chooseVersion("v10");
    expect(chipText()).toEqual(["Changes requested"]);
    await act(async () => { release(); });
    await flush();
    expect(chipText()).toEqual(["Changes requested"]);
  });

  it("an archived project takes the decision controls away but downloads stay", async () => {
    videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })])];
    extra = (url, init) => (url === decisionUrl(asset(10)) && init?.method === "POST" ? json({ error: "project_archived" }, 409) : undefined);
    await open();
    await click(byId("guest-approve"));
    await click(byId("guest-decision-confirm"));
    expect(byId("guest-approve")).toBeNull();
    expect(byId("guest-download")).not.toBeNull();
  });
});

describe("a delivery refresh after an ambiguous decision", () => {
  const ambiguous = (change: () => void): Handler => (url, init) => {
    if (url !== decisionUrl(asset(10)) || init?.method !== "POST") return undefined;
    change();
    return json({ error: "x" }, 503);
  };
  const decide = async () => { await click(byId("guest-approve")); await click(byId("guest-decision-confirm")); };

  it("shows Download and clears the locked reason when staff unlocked the premium Video meanwhile", async () => {
    videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: null })], { premium: true, unlocked: false })];
    extra = ambiguous(() => { videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })], { premium: true, unlocked: true })]; });
    await open();
    expect(byId("guest-download-locked")).not.toBeNull();
    await decide();
    expect(byId("guest-download")?.getAttribute("href")).toBe(downloadUrl(asset(10)));
    expect(byId("guest-download-locked")).toBeNull();
  });

  it("shows the locked reason and no Download when staff relocked the premium Video meanwhile", async () => {
    videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })], { premium: true, unlocked: true })];
    extra = ambiguous(() => { videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: null })], { premium: true, unlocked: false })]; });
    await open();
    expect(byId("guest-download")).not.toBeNull();
    await decide();
    expect(byId("guest-download")).toBeNull();
    expect(byId("guest-download-locked")?.textContent).toMatch(/premium/i);
  });
});

describe("a delivery refresh that finds access changed", () => {
  const ambiguous = (change: () => void): Handler => (url, init) => {
    if (url !== decisionUrl(asset(10)) || init?.method !== "POST") return undefined;
    change();
    return json({ error: "x" }, 503);
  };
  const decide = async () => { await click(byId("guest-approve")); await click(byId("guest-decision-confirm")); };

  it("shows Unavailable when the re-read finds the link gone", async () => {
    let revoked = false;
    extra = (url, init) => {
      if (url === decisionUrl(asset(10)) && init?.method === "POST") { revoked = true; return json({ error: "x" }, 503); }
      if (url === `${BASE}/videos` && revoked) return stub404();
      return undefined;
    };
    await open();
    await decide();
    expect(byId("guest-unavailable")).not.toBeNull();
  });

  it("drops a Version staff removed, so it has no Download, and follows the removal handling when it was the one on screen", async () => {
    videos = [videoOf(1, [versionOf(20), versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })])];
    extra = ambiguous(() => { videos = [videoOf(1, [versionOf(20)])]; });
    await open();
    await chooseVersion("v10");
    expect(byId("guest-download")?.getAttribute("href")).toBe(downloadUrl(asset(10)));
    await decide();
    expect(byId("guest-download")).toBeNull();
    expect(byId("guest-notice")).not.toBeNull();
    expect(byId("guest-video-screen")).not.toBeNull();
  });

  it("a re-read that arrives after the guest moved to a Video staff since removed does not crash, and shows the fallback with the notice", async () => {
    videos = [videoOf(1), videoOf(2)];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    extra = async (url, init) => {
      if (url === decisionUrl(asset(10)) && init?.method === "POST") { await gate; return json({ error: "x" }, 503); }
      return undefined;
    };
    await open();
    const openFilm = (title: string) => click([...document.body.querySelectorAll('[data-testid="guest-row-title"]')].find((el) => el.textContent === title));
    await openFilm("Film 1");
    await decide();
    await click(byId("guest-decision-cancel"));
    await click([...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith("All videos")));
    await openFilm("Film 2");
    expect(byId("guest-video-title")?.textContent).toBe("Film 2");
    videos = [videoOf(1)];
    await act(async () => { release(); });
    await flush();
    expect(byId("guest-notice")).not.toBeNull();
    expect(byId("guest-video-title")?.textContent).toBe("Film 1");
  });

  it("shows the Video with its new Version, not Unavailable, when staff revoked the Version a pending decision was for and granted another", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    extra = async (url, init) => {
      if (url === decisionUrl(asset(10)) && init?.method === "POST") { await gate; return json({ error: "x" }, 503); }
      return undefined;
    };
    await open();
    await decide();
    videos = [videoOf(1, [versionOf(20)])];
    await act(async () => { release(); });
    await flush();
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-video-screen")).not.toBeNull();
    expect(byId("guest-version-trigger")?.textContent).toMatch(/v20/);
  });
});

describe("the decision and Release chips", () => {
  it("show this link's latest decision on the Version on screen", async () => {
    videos = [videoOf(1, [versionOf(20, { decision: decisionOf("changes_requested", 2) }), versionOf(10, { decision: decisionOf("approved") })])];
    await open();
    expect(chipText()).toEqual(["Changes requested"]);
    await chooseVersion("v10");
    expect(chipText()).toEqual(["Approved"]);
  });

  it("show Released only for a released Version, and nothing for a Version with neither", async () => {
    videos = [videoOf(1, [versionOf(20, { released: true, downloadUrl: downloadUrl(asset(20)) }), versionOf(10)])];
    await open();
    expect(allById("guest-released-chip").map((chip) => chip.textContent?.trim())).toEqual(["Released"]);
    await chooseVersion("v10");
    expect(allById("guest-released-chip")).toEqual([]);
    expect(allById("guest-decision-chip")).toEqual([]);
  });

  it("do not appear on the rows of the Video list: the tile shows no decision or Release (#884, D21), but the video screen keeps them", async () => {
    videos = [
      videoOf(1, [versionOf(10, { decision: decisionOf("approved"), released: true, downloadUrl: downloadUrl(asset(10)) })]),
      videoOf(2, [versionOf(20)]),
    ];
    await open();
    const rows = allById("guest-video-row");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector('[data-testid="guest-decision-chip"]')).toBeNull();
      expect(row.querySelector('[data-testid="guest-released-chip"]')).toBeNull();
    }
    await click(allById("guest-row-title")[0]!);
    expect(chipText()).toEqual(["Approved"]);
    expect(allById("guest-released-chip")).toHaveLength(1);
  });
});

describe("Download", () => {
  it("is an anchor to the Version's download URL when the DTO carries one", async () => {
    videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })])];
    await open();
    const link = byId("guest-download") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(downloadUrl(asset(10)));
    expect(link.hasAttribute("download")).toBe(true);
    expect(byId("guest-download-locked")).toBeNull();
  });

  it("is absent for an unreleased Version", async () => {
    await open();
    expect(byId("guest-download")).toBeNull();
    expect(byId("guest-download-locked")).toBeNull();
  });

  it("gives the reason instead of a button for a released premium film that is not unlocked", async () => {
    videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: null })], { premium: true, unlocked: false })];
    await open();
    expect(byId("guest-download")).toBeNull();
    expect(byId("guest-download-locked")?.textContent).toMatch(/premium/i);
  });

  it("is absent, with no reason either, when the link does not allow downloads", async () => {
    session = sessionOf({ allow: { download: false } });
    videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })], { premium: true, unlocked: false })];
    await open();
    expect(byId("guest-download")).toBeNull();
    expect(byId("guest-download-locked")).toBeNull();
    expect(byId("guest-download-all")).toBeNull();
  });

  it("follows the Version on screen", async () => {
    videos = [videoOf(1, [versionOf(20), versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })])];
    await open();
    expect(byId("guest-download")).toBeNull();
    await chooseVersion("v10");
    expect(byId("guest-download")?.getAttribute("href")).toBe(downloadUrl(asset(10)));
  });
});

describe("Download needs a verified guest", () => {
  it("an unverified guest's Download is a button that opens the verify dialog, and after the code it is the anchor with a hint to press it again", async () => {
    session = sessionOf({ verified: false });
    videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })])];
    await open();
    const before = byId("guest-download") as HTMLElement;
    expect(before.tagName).toBe("BUTTON");
    await click(before);
    expect(byId("guest-verify-dialog")).not.toBeNull();
    await completeVerify();
    expect(byId("guest-verify-dialog")).toBeNull();
    const after = byId("guest-download") as HTMLAnchorElement;
    expect(after.tagName).toBe("A");
    expect(after.getAttribute("href")).toBe(downloadUrl(asset(10)));
    expect(byId("guest-download-hint")?.textContent).toMatch(/press download/i);
  });

  it("an unverified guest's Download all opens the verify dialog, not the manifest, and opens its dialog once verified", async () => {
    session = sessionOf({ verified: false });
    videos = [videoOf(1), videoOf(2)];
    manifest = { included: [{ videoId: vid(1), title: "Film 1", version: 1, bytes: 5 }], leftOut: [], totalBytes: 5, tooLarge: false, archive: { state: "ready", pending: 0 } };
    await open();
    await click(byId("guest-download-all"));
    expect(byId("guest-verify-dialog")).not.toBeNull();
    expect(byId("guest-download-all-dialog")).toBeNull();
    expect(gets(`${BASE}/downloads`)).toBe(0);
    await completeVerify();
    expect(byId("guest-verify-dialog")).toBeNull();
    expect(byId("guest-download-all-dialog")).not.toBeNull();
    expect(allById("guest-download-item")).toHaveLength(1);
  });

  it("a 401 on the manifest opens the verify dialog and does not show the Unavailable page", async () => {
    videos = [videoOf(1), videoOf(2)];
    manifest = json({ error: "verification_required" }, 401);
    await open();
    await click(byId("guest-download-all"));
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-verify-dialog")).not.toBeNull();
    expect(byId("guest-download-all-dialog")).toBeNull();
  });
});

describe("Download all", () => {
  const MANIFEST: GuestDownloadManifest = {
    included: [{ videoId: vid(1), title: "Film 1", version: 3, bytes: 5 * 1024 ** 2 }, { videoId: vid(2), title: "Film 2", version: 1, bytes: 2 * 1024 ** 3 }],
    leftOut: [{ title: "Film 3", reason: "not_released" }, { title: "Film 4", reason: "premium_locked" }],
    totalBytes: 5 * 1024 ** 2 + 2 * 1024 ** 3, tooLarge: false, archive: { state: "ready", pending: 0 },
  };
  beforeEach(() => { videos = [videoOf(1), videoOf(2)]; manifest = MANIFEST; });

  it("is offered on a link with several films, on the list and on a film, and not on a single-film link", async () => {
    await open();
    expect(byId("guest-download-all")).not.toBeNull();
    await act(async () => { root!.unmount(); }); root = null; host.remove(); document.body.innerHTML = "";
    videos = [videoOf(1)];
    await open();
    expect(byId("guest-download-all")).toBeNull();
  });

  it("is also on the film screen of a multi-film link", async () => {
    await open();
    await click(allById("guest-video-row")[0]!.querySelector("button"));
    expect(byId("guest-video-screen")).not.toBeNull();
    expect(byId("guest-download-all")).not.toBeNull();
  });

  it("opens a dialog listing what the zip holds and what it leaves out, with the reasons", async () => {
    await open();
    await click(byId("guest-download-all"));
    expect(byId("guest-download-all-dialog")).not.toBeNull();
    const included = allById("guest-download-item").map((row) => row.textContent ?? "");
    expect(included).toHaveLength(2);
    expect(included[0]).toContain("Film 1");
    expect(included[0]).toContain("Version 3");
    expect(included[1]).toContain("Film 2");
    expect(included[1]).toMatch(/2(\.0)? GB/);
    const left = allById("guest-download-leftout-item").map((row) => row.textContent ?? "");
    expect(left).toHaveLength(2);
    expect(left[0]).toContain("Film 3");
    expect(left[0]).toMatch(/not (been )?released/i);
    expect(left[1]).toContain("Film 4");
    expect(left[1]).toMatch(/premium/i);
  });

  it("starts the zip route through an anchor", async () => {
    await open();
    await click(byId("guest-download-all"));
    const start = byId("guest-download-all-start") as HTMLAnchorElement;
    expect(start.tagName).toBe("A");
    expect(start.getAttribute("href")).toBe(`${BASE}/downloads/all.zip`);
    expect(start.hasAttribute("download")).toBe(true);
    expect(start.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("explains the cap and offers no download when the zip is too large", async () => {
    manifest = { ...MANIFEST, tooLarge: true, archive: { state: "too_large", pending: 0 }, totalBytes: 9 * 1024 ** 3 };
    await open();
    await click(byId("guest-download-all"));
    expect(byId("guest-download-all-start")).toBeNull();
    expect(byId("guest-download-all-problem")?.textContent).toMatch(/20 films|8 GB/);
    expect(byId("guest-download-all-dialog")?.textContent).not.toContain("One zip with the released films below.");
  });

  it("says there is nothing to download yet when no film is released", async () => {
    manifest = { included: [], leftOut: [{ title: "Film 1", reason: "not_released" }, { title: "Film 2", reason: "not_released" }], totalBytes: 0, tooLarge: false, archive: { state: "ready", pending: 0 } };
    await open();
    await click(byId("guest-download-all"));
    expect(byId("guest-download-all-start")).toBeNull();
    expect(byId("guest-download-all-problem")?.textContent).toMatch(/nothing/i);
    expect(allById("guest-download-leftout-item")).toHaveLength(2);
  });

  it("shows the zip description only when something is included", async () => {
    manifest = { included: [], leftOut: [{ title: "Film 1", reason: "not_released" }], totalBytes: 0, tooLarge: false, archive: { state: "ready", pending: 0 } };
    await open();
    await click(byId("guest-download-all"));
    expect(byId("guest-download-all-dialog")?.textContent).not.toContain("One zip with the released films below.");
    expect(byId("guest-download-all-dialog")?.textContent).toContain("Nothing is ready to download yet.");
    await act(async () => { root!.unmount(); }); root = null; host.remove(); document.body.innerHTML = "";
    manifest = MANIFEST;
    await open();
    await click(byId("guest-download-all"));
    expect(byId("guest-download-all-dialog")?.textContent).toContain("One zip with the released films below.");
  });

  describe("while the zip is being prepared (#802)", () => {
    const PREPARING: GuestDownloadManifest = { ...MANIFEST, archive: { state: "preparing", pending: 2 } };
    const READY: GuestDownloadManifest = { ...MANIFEST, archive: { state: "ready", pending: 0 } };
    let visible: DocumentVisibilityState = "visible";
    let prepareAnswer: () => Response;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); visible = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visible });
      manifest = PREPARING; prepareAnswer = () => json({ state: "preparing", pending: 2, retryAfterSeconds: 30 });
      extra = (url, init) => (url === `${BASE}/downloads/prepare` && init?.method === "POST" ? prepareAnswer() : undefined);
    });
    afterEach(() => { vi.useRealTimers(); });
    const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); for (let i = 0; i < 3; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
    const openDialog = async () => {
      window.history.replaceState(null, "", `/d/review?link=${LINK}#t=tok123`);
      host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
      await act(async () => { root!.render(<GuestApp token="tok123" />); }); await settle(10);
      await act(async () => { byId("guest-download-all")!.click(); }); await settle(10);
    };
    const preparing = () => byId("guest-download-all-preparing");
    const prepares = () => posts().filter((post) => post.url === `${BASE}/downloads/prepare`).length;

    it("asks the server to prepare, shows the preparing copy, and offers no download link", async () => {
      await openDialog();
      expect(prepares()).toBe(1); expect(preparing()?.textContent).toContain("Preparing this download. This may take a few minutes.");
      expect(byId("guest-download-all-start")).toBeNull(); expect(allById("guest-download-item")).toHaveLength(2);
    });

    it("keeps one status region mounted from preparing to ready, above the list, and its text becomes the ready hint (a11y)", async () => {
      await openDialog();
      const region = preparing()!; expect(region.getAttribute("role")).toBe("status"); expect(region.textContent).toContain("Preparing this download.");
      expect(region.compareDocumentPosition(byId("guest-download-item")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      manifest = READY; await settle(30_000);
      expect(preparing()).toBe(region); expect(region.isConnected).toBe(true); expect(region.getAttribute("role")).toBe("status");
      expect(region.textContent).toContain("Your zip is ready. It starts in your browser when you press Download zip. If nothing downloads, wait a minute and try again.");
      expect(region.textContent).not.toContain("Preparing this download.");
      expect(region.querySelector('svg')).toBeNull();
    });

    it("aligns the spinner with the first line of a wrapped notice", async () => {
      await openDialog();
      const spinner = preparing()!.querySelector('svg')!; expect(spinner.getAttribute("class")).toMatch(/self-start/);
    });

    it("polls the manifest every 30 s; when it reports ready the link appears, and nothing downloads by itself", async () => {
      await openDialog(); const before = gets(`${BASE}/downloads`);
      await settle(30_000); expect(gets(`${BASE}/downloads`)).toBe(before + 1); expect(byId("guest-download-all-start")).toBeNull();
      manifest = READY; await settle(30_000);
      expect(preparing()?.textContent).not.toContain("Preparing this download.");
      const start = byId("guest-download-all-start") as HTMLAnchorElement; expect(start.getAttribute("href")).toBe(`${BASE}/downloads/all.zip`);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/all.zip"))).toBe(false);
      const polls = gets(`${BASE}/downloads`); await settle(120_000); expect(gets(`${BASE}/downloads`)).toBe(polls);
    });

    it("stops polling when the dialog closes, and when the page unmounts", async () => {
      await openDialog(); await settle(30_000); const polls = gets(`${BASE}/downloads`);
      await act(async () => { byId("guest-download-all-close")!.click(); }); await settle(10);
      await settle(120_000); expect(gets(`${BASE}/downloads`)).toBe(polls);
      await act(async () => { byId("guest-download-all")!.click(); }); await settle(10); const reopened = gets(`${BASE}/downloads`);
      await act(async () => { root!.unmount(); }); root = null; await settle(120_000); expect(gets(`${BASE}/downloads`)).toBe(reopened);
    });

    it("gives up after five minutes and offers Check again, which asks the server again", async () => {
      await openDialog(); for (let i = 0; i < 10; i += 1) await settle(30_000); await settle(1_000);
      expect(byId("guest-download-all-check-again")).not.toBeNull(); expect(byId("guest-download-all-start")).toBeNull();
      expect(preparing()?.textContent).toContain("Still preparing. Check again in a minute."); expect(preparing()?.textContent).not.toContain("This may take a few minutes.");
      const polls = gets(`${BASE}/downloads`); await settle(120_000); expect(gets(`${BASE}/downloads`)).toBe(polls);
      await act(async () => { byId("guest-download-all-check-again")!.click(); }); await settle(10);
      expect(prepares()).toBe(2); expect(preparing()).not.toBeNull();
    });

    /** Holds the next manifest read until `release` is called, so a poll can be in flight while the dialog closes or reopens. */
    const holdNextManifestRead = () => {
      let release!: (response: Response) => void; const gate = new Promise<Response>((resolve) => { release = resolve; }); let held = false; const before = extra;
      extra = (url, init) => { if (!held && url === `${BASE}/downloads` && (init?.method ?? "GET") === "GET") { held = true; return gate; } return before?.(url, init); };
      return { release, restore: () => { extra = before; } };
    };

    it("a poll answered after Close changes nothing: a late 401 does not re-read the manifest or open verify (Sol r1 #4)", async () => {
      await openDialog(); const hold = holdNextManifestRead();
      await settle(30_000); const reads = gets(`${BASE}/downloads`);
      await act(async () => { byId("guest-download-all-close")!.click(); }); await settle(10);
      hold.release(json({ error: "verification_required" }, 401)); await settle(10);
      expect(gets(`${BASE}/downloads`)).toBe(reads); expect(byId("guest-verify-dialog")).toBeNull(); expect(byId("guest-download-all-dialog")).toBeNull();
    });

    it("a poll answered after a newer opening cannot overwrite what that opening loaded (Sol r1 #4)", async () => {
      await openDialog(); const hold = holdNextManifestRead();
      await settle(30_000);
      await act(async () => { byId("guest-download-all-close")!.click(); }); await settle(10);
      await act(async () => { byId("guest-download-all")!.click(); }); await settle(10);
      expect(allById("guest-download-item")).toHaveLength(2);
      hold.release(json({ ...READY, included: READY.included.slice(0, 1) })); await settle(10);
      expect(allById("guest-download-item")).toHaveLength(2);
    });

    it("does not poll while the page is hidden", async () => {
      await openDialog(); visible = "hidden"; const polls = gets(`${BASE}/downloads`);
      await settle(120_000); expect(gets(`${BASE}/downloads`)).toBe(polls);
    });

    it("says it could not prepare when the server reports the zip unavailable, with Check again", async () => {
      manifest = { ...MANIFEST, archive: { state: "unavailable", pending: 0 } }; await openDialog();
      expect(byId("guest-download-all-problem")?.textContent).toContain("Couldn't prepare this zip. Try again or download the files one at a time.");
      expect(byId("guest-download-all-check-again")).not.toBeNull(); expect(byId("guest-download-all-start")).toBeNull(); expect(prepares()).toBe(0);
    });

    it("says the zip is too big when the archive is over what one zip can hold", async () => {
      manifest = { ...MANIFEST, archive: { state: "too_large", pending: 0 } }; await openDialog();
      expect(byId("guest-download-all-problem")?.textContent).toMatch(/too big|more than one zip/i); expect(byId("guest-download-all-start")).toBeNull();
    });

    it("a ready archive is the plain link and writes no prepare request", async () => {
      manifest = READY; await openDialog();
      expect(byId("guest-download-all-start")).not.toBeNull(); expect(prepares()).toBe(0); expect(preparing()?.textContent ?? "").not.toContain("Preparing this download.");
    });
  });

  it("reads the manifest fresh each time it opens", async () => {
    await open();
    await click(byId("guest-download-all"));
    await click(byId("guest-download-all-close"));
    await click(byId("guest-download-all"));
    expect(gets(`${BASE}/downloads`)).toBe(2);
  });

  it("403 download_disabled closes the dialog, removes every download control and keeps the review with a notice", async () => {
    manifest = json({ error: "download_disabled" }, 403);
    videos = [videoOf(1, [versionOf(10, { released: true, downloadUrl: downloadUrl(asset(10)) })]), videoOf(2)];
    await open();
    await click(allById("guest-video-row")[0]!.querySelector("button"));
    expect(byId("guest-video-screen")).not.toBeNull();
    expect(byId("guest-download")).not.toBeNull();
    await click(byId("guest-download-all"));
    expect(byId("guest-unavailable")).toBeNull();
    expect(byId("guest-video-screen")).not.toBeNull();
    expect(byId("guest-download-all-dialog")).toBeNull();
    expect(byId("guest-download-all")).toBeNull();
    expect(byId("guest-download")).toBeNull();
    expect(byId("guest-download-all-disabled")?.textContent).toBe("Downloads are turned off for this review.");
  });

  it("a failed manifest read offers to try again, and a stub answer is the unavailable page", async () => {
    manifest = new Response("x", { status: 503 });
    await open();
    await click(byId("guest-download-all"));
    expect(byId("guest-download-all-problem")?.textContent).toMatch(/couldn't|try again/i);
    expect(byId("guest-download-all-start")).toBeNull();
    manifest = MANIFEST;
    await click(byId("guest-download-all-retry"));
    expect(allById("guest-download-item")).toHaveLength(2);
    manifest = stub404();
    await click(byId("guest-download-all-close"));
    await click(byId("guest-download-all"));
    expect(byId("guest-unavailable")).not.toBeNull();
  });
});
