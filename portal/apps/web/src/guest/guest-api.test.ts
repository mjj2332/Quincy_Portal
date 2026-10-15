import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuestApi, postUnsubscribe } from "./guest-api";

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET = "00000000-0000-4000-8000-000000000010";
const NOTE = "22222222-2222-4222-8222-222222222222";
const thread = (over: Record<string, unknown> = {}) => ({
  id: NOTE, parentId: null, author: { kind: "guest", name: "Sam", self: true }, startFrame: 50, endFrame: null, drawingFrame: null, hasMarkup: false, body: "Hi", deleted: false, revision: 1,
  resolved: false, createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, replies: [], ...over,
});
const SESSION = { link: { label: null, expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: true, approve: false, download: false, markup: true } }, verified: true, email: "sam@example.com", name: "Sam", notifications: null, media: { heic: false } };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
const answer = (response: Response | (() => Promise<Response>)) => { fetchMock.mockImplementation(async () => (typeof response === "function" ? response() : response)); };
beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock as unknown as typeof fetch; });
afterEach(() => { vi.restoreAllMocks(); });
const api = () => createGuestApi(LINK);
const lastCall = () => { const call = fetchMock.mock.calls.at(-1)!; return { url: String(call[0]), init: call[1] as RequestInit }; };

describe("guest-api: email code", () => {
  it("posts the address as JSON to the link's code route, same-origin", async () => {
    answer(json({ sent: true, resendAfterSeconds: 60 }, 202));
    expect(await api().sendCode("sam@example.com")).toEqual({ ok: true, resendAfterSeconds: 60 });
    const { url, init } = lastCall();
    expect(url).toBe(`/d/api/links/${LINK}/email/code`);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(String(init.body))).toEqual({ email: "sam@example.com" });
  });
  it("maps 429 to the server's retry time, 400 to invalid, a stub to gone, and 5xx or a dropped connection to unreachable", async () => {
    answer(json({ error: "too_many_attempts", retryAfterSeconds: 42 }, 429, { "retry-after": "42" }));
    expect(await api().sendCode("a@b.co")).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 42 });
    answer(new Response("", { status: 429, headers: { "retry-after": "17" } }));
    expect(await api().sendCode("a@b.co")).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 17 });
    answer(json({ error: "invalid_request" }, 400));
    expect(await api().sendCode("nope")).toEqual({ ok: false, reason: "invalid" });
    answer(new Response("Not found", { status: 404 }));
    expect(await api().sendCode("a@b.co")).toEqual({ ok: false, reason: "gone" });
    answer(json({ error: "project_archived" }, 409));
    expect(await api().sendCode("a@b.co")).toEqual({ ok: false, reason: "archived" });
    answer(new Response("", { status: 503 }));
    expect(await api().sendCode("a@b.co")).toEqual({ ok: false, reason: "unreachable" });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await api().sendCode("a@b.co")).toEqual({ ok: false, reason: "unreachable" });
  });
  it("maps 409 already_verified to its own outcome, not to gone", async () => {
    answer(json({ error: "already_verified" }, 409));
    expect(await api().sendCode("a@b.co")).toEqual({ ok: false, reason: "already_verified" });
  });
  it("verify returns the new session body, and names each refusal", async () => {
    answer(json(SESSION));
    expect(await api().verifyCode("123456", "Sam")).toEqual({ ok: true, session: SESSION });
    expect(lastCall().url).toBe(`/d/api/links/${LINK}/email/verify`);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ code: "123456", name: "Sam" });
    answer(json({ error: "code_incorrect", attemptsLeft: 3 }, 401));
    expect(await api().verifyCode("000000", "Sam")).toEqual({ ok: false, reason: "code_incorrect", attemptsLeft: 3 });
    answer(json({ error: "code_expired" }, 401));
    expect(await api().verifyCode("000000", "Sam")).toEqual({ ok: false, reason: "code_expired" });
    answer(json({ error: "already_verified" }, 409));
    expect(await api().verifyCode("000000", "Sam")).toEqual({ ok: false, reason: "already_verified" });
    answer(json({ error: "too_many_attempts", retryAfterSeconds: 300 }, 429));
    expect(await api().verifyCode("000000", "Sam")).toEqual({ ok: false, reason: "limited", retryAfterSeconds: 300 });
    answer(new Response("Not found", { status: 404 }));
    expect(await api().verifyCode("000000", "Sam")).toEqual({ ok: false, reason: "gone" });
  });
});

describe("guest-api: social overlays (#872)", () => {
  const OVERLAY = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Instagram Reel", imageUrl: "/social-overlay-images/cccccccc-cccc-4ccc-8ccc-cccccccccccc/dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
  it("reads the list from its own route", async () => {
    answer(json({ socialOverlays: [OVERLAY] }));
    expect(await api().socialOverlays()).toEqual({ kind: "ok", value: [OVERLAY] });
    expect(lastCall().url).toBe(`/d/api/links/${LINK}/social-overlays`);
  });
  it("rejects a payload without the field, an overlay with extra metadata, and an image path outside the overlay library", async () => {
    for (const body of [{}, { socialOverlays: [{ ...OVERLAY, platformLabel: "Instagram" }] }, { socialOverlays: [{ ...OVERLAY, imageUrl: "https://elsewhere.test/x.png" }] }]) {
      answer(json(body));
      expect((await api().socialOverlays()).kind).not.toBe("ok");
    }
  });
  it("leaves /videos as the strict { videos } shape the deployed page parses", async () => {
    answer(json({ videos: [] }));
    expect(await api().videos()).toEqual({ kind: "ok", value: [] });
    answer(json({ videos: [], socialOverlays: [OVERLAY] }));
    expect((await api().videos()).kind).not.toBe("ok");
  });
});

describe("guest-api: download policy (#882)", () => {
  it("reads {codeRequired} from its own route", async () => {
    answer(json({ codeRequired: false }));
    expect(await api().downloadPolicy()).toEqual({ codeRequired: false });
    expect(lastCall().url).toBe(`/d/api/links/${LINK}/download-policy`);
  });
  it("any failure is codeRequired true: the stub, a 500, a bad body, an extra key, a dropped connection", async () => {
    for (const make of [() => new Response("nope", { status: 404 }), () => new Response("boom", { status: 500 }), () => json({ codeRequired: "no" }), () => json({ codeRequired: false, extra: 1 }), () => json({})]) {
      answer(make());
      expect(await api().downloadPolicy()).toEqual({ codeRequired: true });
    }
  });
  it("leaves /session as the strict shape the deployed page parses", async () => {
    answer(json({ ...SESSION, codeRequired: false }));
    expect((await api().session()).kind).not.toBe("ok");
  });
});

describe("guest-api: note writes", () => {
  it("creates a note with a POST to the Version and parses the thread", async () => {
    answer(json(thread(), 201));
    const result = await api().createNote(ASSET, { startFrame: 50, body: "Hi" });
    expect(result).toEqual({ kind: "ok", thread: thread() });
    expect(lastCall().url).toBe(`/d/api/links/${LINK}/versions/${ASSET}/notes`);
    expect(lastCall().init.method).toBe("POST");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ startFrame: 50, body: "Hi" });
  });
  it("replies, edits and deletes on the note's own routes", async () => {
    answer(json(thread({ replies: [] }), 201));
    const doc = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "Thanks" }] }] };
    await api().replyToNote(NOTE, doc);
    expect([lastCall().url, lastCall().init.method, lastCall().init.body]).toEqual([`/d/api/links/${LINK}/notes/${NOTE}/replies`, "POST", JSON.stringify({ content: doc })]);
    answer(json(thread({ revision: 2 })));
    expect(await api().editNote(NOTE, { expectedRevision: 1, body: "New" })).toEqual({ kind: "ok", thread: thread({ revision: 2 }) });
    expect([lastCall().url, lastCall().init.method]).toEqual([`/d/api/links/${LINK}/notes/${NOTE}`, "PATCH"]);
    answer(json({ thread: null }));
    expect(await api().deleteNote(NOTE, 2)).toEqual({ kind: "ok", thread: null });
    expect([lastCall().url, lastCall().init.method, lastCall().init.body]).toEqual([`/d/api/links/${LINK}/notes/${NOTE}`, "DELETE", JSON.stringify({ expectedRevision: 2 })]);
  });
  it("classifies every refusal", async () => {
    const run = () => api().editNote(NOTE, { expectedRevision: 1, body: "x" });
    answer(json({ error: "verification_required" }, 401));
    expect(await run()).toEqual({ kind: "unverified" });
    answer(new Response("Not found", { status: 404 }));
    expect(await run()).toEqual({ kind: "gone" });
    answer(json({ error: "comments_disabled" }, 403));
    expect(await run()).toEqual({ kind: "gone" });
    answer(json({ error: "invalid_origin" }, 403));
    expect(await run()).toEqual({ kind: "gone" });
    answer(json({ error: "not_author" }, 403));
    expect(await run()).toEqual({ kind: "rejected", error: "not_author" });
    answer(json({ error: "project_archived" }, 409));
    expect(await run()).toEqual({ kind: "archived" });
    answer(json({ error: "note_deleted" }, 409));
    expect(await run()).toEqual({ kind: "deleted" });
    answer(json({ error: "note_conflict", thread: thread({ revision: 3, body: "Theirs" }) }, 409));
    expect(await run()).toEqual({ kind: "conflict", thread: thread({ revision: 3, body: "Theirs" }) });
    answer(json({ error: "too_many_attempts", retryAfterSeconds: 90 }, 429, { "retry-after": "90" }));
    expect(await run()).toEqual({ kind: "limited", retryAfterSeconds: 90 });
    answer(json({ error: "payload_too_large" }, 413));
    expect(await run()).toEqual({ kind: "rejected", error: "payload_too_large" });
    answer(json({ error: "frame_out_of_range" }, 422));
    expect(await run()).toEqual({ kind: "rejected", error: "frame_out_of_range" });
    answer(new Response("", { status: 500 }));
    expect(await run()).toEqual({ kind: "unreachable" });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await run()).toEqual({ kind: "unreachable" });
  });
  it("treats a success body that fails the schema as unreachable, never as an applied write", async () => {
    answer(json({ id: "nope" }, 201));
    expect(await api().createNote(ASSET, { startFrame: 1, body: "x" })).toEqual({ kind: "unreachable" });
  });
});

describe("postUnsubscribe: body read failures (#741 15b)", () => {
  it("maps a 200 whose body cannot be read to transient, so Retry stays available", async () => {
    const dropped = new Response("{}", { status: 200 });
    vi.spyOn(dropped, "json").mockRejectedValue(new TypeError("network connection lost"));
    answer(dropped);
    expect(await postUnsubscribe("tok")).toEqual({ kind: "transient" });
  });
  it("still maps a 200 whose body fails the schema to gone, and a good body to ok", async () => {
    answer(json({ subscribed: "yes" }));
    expect(await postUnsubscribe("tok")).toEqual({ kind: "gone" });
    answer(json({ subscribed: false }));
    expect(await postUnsubscribe("tok")).toEqual({ kind: "ok", subscribed: false });
  });
});

const SOURCE = "00000000-0000-4000-8000-000000000011";
const COPY = "33333333-3333-4333-8333-333333333333";
const sourceRow = { revision: 1, visibility: "public", authorName: "Sam", excerpt: "Hi", from: { startFrame: 50, endFrame: null } };
const plan = { sourceVersion: 1, targetVersion: 2, offsetFrames: 0, rows: [{ noteId: NOTE, status: "mapped", source: sourceRow, to: { startFrame: 50, endFrame: null }, shortened: false }] };
const receipt = { sourceVersion: 1, targetVersion: 2, offsetFrames: 0, copied: 1, skipped: 0, rows: [{ noteId: NOTE, status: "copied", source: sourceRow, to: { startFrame: 50, endFrame: null }, shortened: false, copyId: COPY }] };

describe("guest-api: note paste", () => {
  it("posts the preview to the target Version's paste route and parses the plan", async () => {
    answer(json(plan));
    expect(await api().previewPaste(ASSET, { sourceAssetId: SOURCE, noteIds: [NOTE], offsetFrames: 3 })).toEqual({ kind: "ok", value: plan });
    const { url, init } = lastCall();
    expect([url, init.method, init.credentials]).toEqual([`/d/api/links/${LINK}/versions/${ASSET}/note-paste/preview`, "POST", "same-origin"]);
    expect(JSON.parse(String(init.body))).toEqual({ sourceAssetId: SOURCE, noteIds: [NOTE], offsetFrames: 3 });
  });
  it("posts the commit to the note-paste route and parses the receipt", async () => {
    answer(json(receipt));
    expect(await api().commitPaste(ASSET, { sourceAssetId: SOURCE, notes: [{ noteId: NOTE, revision: 1 }], offsetFrames: 0 })).toEqual({ kind: "ok", value: receipt });
    const { url, init } = lastCall();
    expect([url, init.method]).toEqual([`/d/api/links/${LINK}/versions/${ASSET}/note-paste`, "POST"]);
    expect(JSON.parse(String(init.body))).toEqual({ sourceAssetId: SOURCE, notes: [{ noteId: NOTE, revision: 1 }], offsetFrames: 0 });
  });
  it("classifies every refusal, and reads 409 paste_stale as the fresh plan", async () => {
    const run = () => api().commitPaste(ASSET, { sourceAssetId: SOURCE, notes: [{ noteId: NOTE, revision: 1 }], offsetFrames: 0 });
    answer(json({ error: "verification_required" }, 401));
    expect(await run()).toEqual({ kind: "unverified" });
    answer(new Response("Not found", { status: 404 }));
    expect(await run()).toEqual({ kind: "gone" });
    answer(json({ error: "comments_disabled" }, 403));
    expect(await run()).toEqual({ kind: "gone" });
    answer(json({ error: "project_archived" }, 409));
    expect(await run()).toEqual({ kind: "archived" });
    answer(json({ error: "paste_stale", preview: plan }, 409));
    expect(await run()).toEqual({ kind: "changed", preview: plan });
    answer(json({ error: "too_many_attempts", retryAfterSeconds: 30 }, 429, { "retry-after": "30" }));
    expect(await run()).toEqual({ kind: "limited", retryAfterSeconds: 30 });
    answer(json({ error: "same_version" }, 422));
    expect(await run()).toEqual({ kind: "rejected", error: "same_version" });
    answer(new Response("", { status: 500 }));
    expect(await run()).toEqual({ kind: "unreachable" });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await run()).toEqual({ kind: "unreachable" });
  });
  it("treats a success body that fails the schema as unreachable", async () => {
    answer(json({ rows: "nope" }));
    expect(await api().previewPaste(ASSET, { sourceAssetId: SOURCE, noteIds: [NOTE], offsetFrames: 0 })).toEqual({ kind: "unreachable" });
  });
});

describe("guest-api: decisions and downloads (#741 14-ui-guest)", () => {
  const DECISION = { value: "approved", revision: 2, at: "2026-10-10T01:00:00.000Z", self: true };
  const run = () => api().decide(ASSET, "approved");
  it("posts the decision JSON to the Version's decision route, with the note only when given", async () => {
    answer(json({ decision: DECISION }, 201));
    expect(await run()).toEqual({ kind: "ok", decision: DECISION });
    expect(lastCall().url).toBe(`/d/api/links/${LINK}/versions/${ASSET}/decision`);
    expect(lastCall().init.method).toBe("POST");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ decision: "approved" });
    await api().decide(ASSET, "changes_requested", "Shorten it");
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ decision: "changes_requested", note: "Shorten it" });
  });
  it("maps every refusal the route can give", async () => {
    answer(json({ error: "verification_required" }, 401));
    expect(await run()).toEqual({ kind: "unverified" });
    answer(json({ error: "approve_disabled" }, 403));
    expect(await run()).toEqual({ kind: "disabled" });
    answer(json({ error: "something_else" }, 403));
    expect(await run()).toEqual({ kind: "gone" });
    answer(new Response("Not found", { status: 404 }));
    expect(await run()).toEqual({ kind: "gone" });
    answer(json({ error: "project_archived" }, 409));
    expect(await run()).toEqual({ kind: "archived" });
    answer(json({ error: "decision_conflict" }, 409));
    expect(await run()).toEqual({ kind: "conflict" });
    answer(json({ error: "too_many_attempts", retryAfterSeconds: 30 }, 429, { "retry-after": "30" }));
    expect(await run()).toEqual({ kind: "limited", retryAfterSeconds: 30 });
    answer(json({ error: "invalid_request" }, 400));
    expect(await run()).toEqual({ kind: "rejected", error: "invalid_request" });
    answer(new Response("", { status: 502 }));
    expect(await run()).toEqual({ kind: "unreachable" });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await run()).toEqual({ kind: "unreachable" });
  });
  it("treats a success body that fails the schema as unreachable, never as a recorded decision", async () => {
    answer(json({ decision: { value: "maybe" } }, 201));
    expect(await run()).toEqual({ kind: "unreachable" });
  });
  it("reads the Download all manifest through the strict schema and exposes the zip route", async () => {
    const manifest = { included: [{ videoId: "11111111-1111-4111-8111-111111111111", title: "Film", version: 2, bytes: 10 }], leftOut: [{ title: "Other", reason: "not_released" }], totalBytes: 10, tooLarge: false, archive: { state: "ready", pending: 0 } };
    answer(json(manifest));
    expect(await api().downloads()).toEqual({ kind: "ok", value: manifest });
    expect(lastCall().url).toBe(`/d/api/links/${LINK}/downloads`);
    expect(api().downloadAllUrl).toBe(`/d/api/links/${LINK}/downloads/all.zip`);
    answer(json({ ...manifest, extra: 1 }));
    expect(await api().downloads()).toEqual({ kind: "gone" });
    answer(new Response("", { status: 503 }));
    expect(await api().downloads()).toEqual({ kind: "transient" });
  });
  it("maps a 401 on the manifest to verify (the guest has to confirm an email first), never to gone; only a 404 is gone", async () => {
    answer(json({ error: "verification_required" }, 401));
    expect(await api().downloads()).toEqual({ kind: "verify" });
    answer(new Response("", { status: 401 }));
    expect(await api().downloads()).toEqual({ kind: "verify" });
    answer(new Response("Not found", { status: 404 }));
    expect(await api().downloads()).toEqual({ kind: "gone" });
  });
  it("maps 403 download_disabled on the manifest to disabled (staff turned downloads off), never to gone; any other 403 stays gone", async () => {
    answer(json({ error: "download_disabled" }, 403));
    expect(await api().downloads()).toEqual({ kind: "disabled" });
    answer(json({ error: "something_else" }, 403));
    expect(await api().downloads()).toEqual({ kind: "gone" });
  });
  it("prepares Download all with a POST and reads the archive state through the strict schema", async () => {
    answer(json({ state: "preparing", pending: 2, retryAfterSeconds: 30 }));
    expect(await api().prepareDownloads()).toEqual({ kind: "ok", value: { state: "preparing", pending: 2, retryAfterSeconds: 30 } });
    expect(lastCall().url).toBe(`/d/api/links/${LINK}/downloads/prepare`); expect(lastCall().init?.method).toBe("POST");
    answer(json({ state: "ready", pending: 0, extra: 1 })); expect(await api().prepareDownloads()).toEqual({ kind: "gone" });
  });
  it("reads a prepare refusal for what it is: 401 verify, 403 download_disabled, 409/422 rejected, a 429 or a 5xx transient, never gone", async () => {
    answer(json({ error: "verification_required" }, 401)); expect(await api().prepareDownloads()).toEqual({ kind: "verify" });
    answer(json({ error: "download_disabled" }, 403)); expect(await api().prepareDownloads()).toEqual({ kind: "disabled" });
    answer(json({ error: "nothing_to_download" }, 409)); expect(await api().prepareDownloads()).toEqual({ kind: "rejected" });
    answer(json({ error: "zip_too_large" }, 422)); expect(await api().prepareDownloads()).toEqual({ kind: "rejected" });
    answer(json({ error: "too_many_attempts" }, 429)); expect(await api().prepareDownloads()).toEqual({ kind: "transient" });
    answer(new Response("", { status: 503 })); expect(await api().prepareDownloads()).toEqual({ kind: "transient" });
    answer(new Response("Not found", { status: 404 })); expect(await api().prepareDownloads()).toEqual({ kind: "gone" });
  });
});

describe("guest-api: endSession (#854)", () => {
  it("sends DELETE to the session route, same-origin, and reads 204 as ok", async () => {
    answer(new Response(null, { status: 204 }));
    expect(await api().endSession()).toBe("ok");
    const { url, init } = lastCall();
    expect(url).toBe(`/d/api/links/${LINK}/session`); expect(init.method).toBe("DELETE"); expect(init.credentials).toBe("same-origin");
    // The worker's `originRejection` answers 403 to an unsafe request without a JSON content type (and a 403 would read as signed out), so the header is part of the contract.
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });
  it("reads a 4xx (staff already ended it, or the stub) as gone, and a 5xx, a 429 or a dropped connection as transient", async () => {
    answer(new Response("Not found", { status: 404 })); expect(await api().endSession()).toBe("gone");
    answer(json({ error: "invalid_origin" }, 403)); expect(await api().endSession()).toBe("transient");
    answer(new Response("", { status: 503 })); expect(await api().endSession()).toBe("transient");
    answer(new Response("", { status: 429 })); expect(await api().endSession()).toBe("transient");
    fetchMock.mockImplementation(async () => { throw new TypeError("offline"); });
    expect(await api().endSession()).toBe("transient");
  });
});

describe("guest-api: version summaries (#879)", () => {
  const VIDEO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ROW = { assetId: ASSET, version: 2, createdAt: "2026-10-09T01:00:00.000Z", openNoteCount: 3 };
  it("reads the Versions from the Video's own route", async () => {
    answer(json({ versions: [ROW] }));
    expect(await api().versionSummaries(VIDEO)).toEqual({ kind: "ok", value: [ROW] });
    expect(lastCall().url).toBe(`/d/api/links/${LINK}/videos/${VIDEO}/version-summaries`);
  });
  it("rejects a payload with another key, and is not a statement about the link when the read fails", async () => {
    answer(json({ versions: [ROW], extra: 1 }));
    expect((await api().versionSummaries(VIDEO)).kind).not.toBe("ok");
    answer(new Response("boom", { status: 500 }));
    expect((await api().versionSummaries(VIDEO)).kind).toBe("transient");
  });
});
