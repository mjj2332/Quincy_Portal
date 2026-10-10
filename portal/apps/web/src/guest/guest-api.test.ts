import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuestApi } from "./guest-api";

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET = "00000000-0000-4000-8000-000000000010";
const NOTE = "22222222-2222-4222-8222-222222222222";
const thread = (over: Record<string, unknown> = {}) => ({
  id: NOTE, parentId: null, author: { kind: "guest", name: "Sam", self: true }, startFrame: 50, endFrame: null, drawingFrame: null, hasMarkup: false, body: "Hi", deleted: false, revision: 1,
  resolved: false, createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, replies: [], ...over,
});
const SESSION = { link: { label: null, expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: true, approve: false, download: false } }, verified: true, email: "sam@example.com", name: "Sam" };
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
    await api().replyToNote(NOTE, "Thanks");
    expect([lastCall().url, lastCall().init.method, lastCall().init.body]).toEqual([`/d/api/links/${LINK}/notes/${NOTE}/replies`, "POST", JSON.stringify({ body: "Thanks" })]);
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
