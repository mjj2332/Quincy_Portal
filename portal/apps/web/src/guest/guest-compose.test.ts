import { describe, expect, it } from "vitest";
import type { GuestNoteThreadDto, MarkupItem } from "@quincy/shared";
import { composeInput, failureText, removeThread, upsertThread } from "./guest-compose";

const thread = (id: string, startFrame: number, over: Partial<GuestNoteThreadDto> = {}): GuestNoteThreadDto => ({
  id, parentId: null, author: { kind: "studio", name: "Mia" }, startFrame, endFrame: null, drawingFrame: null, hasMarkup: false, body: id, deleted: false, resolved: false, revision: 1,
  createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, replies: [], ...over,
});
const stroke: MarkupItem = { color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] };

describe("composeInput", () => {
  const base = { frameCount: 1000, items: [] as MarkupItem[], drawingFrame: null };
  it("a point mark is a point note at that frame, with the body trimmed", () => {
    expect(composeInput({ ...base, body: "  Trim this  ", marks: { in: 50, out: null } })).toEqual({ ok: true, input: { startFrame: 50, body: "Trim this" } });
  });
  it("in and out make a range whose end is exclusive", () => {
    expect(composeInput({ ...base, body: "x", marks: { in: 50, out: 74 } })).toEqual({ ok: true, input: { startFrame: 50, endFrame: 75, body: "x" } });
  });
  it("refuses an empty body, with no marks, and a body of only spaces", () => {
    expect(composeInput({ ...base, body: "   ", marks: { in: 5, out: null } })).toMatchObject({ ok: false });
    expect(composeInput({ ...base, body: "x", marks: { in: null, out: null } })).toMatchObject({ ok: false });
  });
  it("sends the drawing with its frame when the frame is inside the note", () => {
    expect(composeInput({ ...base, body: "x", marks: { in: 50, out: null }, items: [stroke], drawingFrame: 50 })).toEqual({ ok: true, input: { startFrame: 50, body: "x", markup: [stroke], drawingFrame: 50 } });
    expect(composeInput({ ...base, body: "x", marks: { in: 50, out: 60 }, items: [stroke], drawingFrame: 55 })).toMatchObject({ ok: true });
  });
  it("refuses a drawing whose frame the marks no longer cover (a point must sit on it; a range is half open)", () => {
    expect(composeInput({ ...base, body: "x", marks: { in: 51, out: null }, items: [stroke], drawingFrame: 50 })).toMatchObject({ ok: false, problem: expect.stringMatching(/drawing/i) });
    expect(composeInput({ ...base, body: "x", marks: { in: 50, out: 60 }, items: [stroke], drawingFrame: 61 })).toMatchObject({ ok: false });
    expect(composeInput({ ...base, body: "x", marks: { in: 50, out: 60 }, items: [stroke], drawingFrame: 60 })).toMatchObject({ ok: true });
  });
  it("ignores a drawing frame when there are no strokes", () => {
    expect(composeInput({ ...base, body: "x", marks: { in: 50, out: null }, items: [], drawingFrame: 12 })).toEqual({ ok: true, input: { startFrame: 50, body: "x" } });
  });
});

describe("thread list helpers", () => {
  it("upsert replaces by id, and inserts a new thread in the server's order (start frame, then created, then id)", () => {
    const list = [thread("a", 10), thread("c", 90)];
    expect(upsertThread(list, thread("a", 10, { body: "new" })).map((t) => t.body)).toEqual(["new", "c"]);
    expect(upsertThread(list, thread("b", 50)).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(upsertThread(list, thread("z", 10, { createdAt: "2026-10-09T02:00:00.000Z" })).map((t) => t.id)).toEqual(["a", "z", "c"]);
  });
  it("remove drops the thread and leaves the rest", () => {
    expect(removeThread([thread("a", 1), thread("b", 2)], "a").map((t) => t.id)).toEqual(["b"]);
    expect(removeThread([thread("a", 1)], "missing").map((t) => t.id)).toEqual(["a"]);
  });
});

describe("failureText", () => {
  it("names each refusal for the guest, and has nothing to say about a success", () => {
    expect(failureText({ kind: "ok", thread: null })).toBeNull();
    expect(failureText({ kind: "conflict", thread: thread("a", 1) })).toMatch(/changed/i);
    expect(failureText({ kind: "deleted" })).toMatch(/deleted/i);
    expect(failureText({ kind: "unverified" })).toMatch(/verify/i);
    expect(failureText({ kind: "archived" })).toMatch(/archived/i);
    expect(failureText({ kind: "limited", retryAfterSeconds: 120 })).toMatch(/2 minutes/);
    expect(failureText({ kind: "limited", retryAfterSeconds: 30 })).toMatch(/30 seconds/);
    expect(failureText({ kind: "unreachable" })).toMatch(/couldn.t reach/i);
    expect(failureText({ kind: "rejected", error: "not_author" })).toMatch(/your own/i);
    expect(failureText({ kind: "rejected", error: "frame_out_of_range" })).toMatch(/outside/i);
    expect(failureText({ kind: "rejected", error: "markup_too_large" })).toMatch(/too large/i);
    expect(failureText({ kind: "rejected", error: "whatever" })).toMatch(/couldn.t be saved/i);
  });
});
