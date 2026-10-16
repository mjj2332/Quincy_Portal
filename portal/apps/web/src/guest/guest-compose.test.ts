import { describe, expect, it } from "vitest";
import type { GuestNoteThreadDto, MarkupItem, RichTextDoc } from "@quincy/shared";
import { composeInput, editPatch, failureText, openThreadCount, removeThread, upsertThread } from "./guest-compose";

const thread = (id: string, startFrame: number, over: Partial<GuestNoteThreadDto> = {}): GuestNoteThreadDto => ({
  id, parentId: null, author: { kind: "studio", name: "Mia" }, startFrame, endFrame: null, drawingFrame: null, hasMarkup: false, body: id, deleted: false, resolved: false, revision: 1,
  createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, replies: [], ...over,
});
const para = (text: string): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", ...(text === "" ? {} : { content: [{ type: "text", text }] }) }] }) as RichTextDoc;
const image = (mediaId: string) => ({ type: "image", attrs: { mediaId } });
const stroke: MarkupItem = { color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] };

describe("composeInput", () => {
  const base = { frameCount: 1000, items: [] as MarkupItem[], drawingFrame: null };
  it("a point mark is a point note at that frame, and the document is sent as content", () => {
    expect(composeInput({ ...base, doc: para("Trim this"), marks: { in: 50, out: null } })).toEqual({ ok: true, input: { startFrame: 50, content: para("Trim this") } });
  });
  it("in and out make a range whose end is exclusive", () => {
    expect(composeInput({ ...base, doc: para("x"), marks: { in: 50, out: 74 } })).toEqual({ ok: true, input: { startFrame: 50, endFrame: 75, content: para("x") } });
  });
  it("refuses an empty document, a document of only spaces, and a note with no marks", () => {
    expect(composeInput({ ...base, doc: para(""), marks: { in: 5, out: null } })).toMatchObject({ ok: false });
    expect(composeInput({ ...base, doc: para("   "), marks: { in: 5, out: null } })).toMatchObject({ ok: false });
    expect(composeInput({ ...base, doc: para("x"), marks: { in: null, out: null } })).toMatchObject({ ok: false });
  });
  it("sends the drawing with its frame when the frame is inside the note", () => {
    expect(composeInput({ ...base, doc: para("x"), marks: { in: 50, out: null }, items: [stroke], drawingFrame: 50 })).toEqual({ ok: true, input: { startFrame: 50, content: para("x"), markup: [stroke], drawingFrame: 50 } });
    expect(composeInput({ ...base, doc: para("x"), marks: { in: 50, out: 60 }, items: [stroke], drawingFrame: 55 })).toMatchObject({ ok: true });
  });
  it("refuses a drawing whose frame the marks no longer cover (a point must sit on it; a range is half open)", () => {
    expect(composeInput({ ...base, doc: para("x"), marks: { in: 51, out: null }, items: [stroke], drawingFrame: 50 })).toMatchObject({ ok: false, problem: expect.stringMatching(/drawing/i) });
    expect(composeInput({ ...base, doc: para("x"), marks: { in: 50, out: 60 }, items: [stroke], drawingFrame: 61 })).toMatchObject({ ok: false });
    expect(composeInput({ ...base, doc: para("x"), marks: { in: 50, out: 60 }, items: [stroke], drawingFrame: 60 })).toMatchObject({ ok: true });
  });
  it("a note that is only a picture is a note, and a note too long is refused", () => {
    const only = { type: "doc", content: [image("m1")] } as RichTextDoc;
    expect(composeInput({ ...base, doc: only, marks: { in: 5, out: null } })).toEqual({ ok: true, input: { startFrame: 5, content: only } });
    expect(composeInput({ ...base, doc: para("x".repeat(10_001)), marks: { in: 5, out: null } })).toMatchObject({ ok: false, problem: expect.stringMatching(/too long/i) });
  });
  it("ignores a drawing frame when there are no strokes", () => {
    expect(composeInput({ ...base, doc: para("x"), marks: { in: 50, out: null }, items: [], drawingFrame: 12 })).toEqual({ ok: true, input: { startFrame: 50, content: para("x") } });
  });
});

describe("thread list helpers", () => {
  it("upsert replaces by id, and inserts a new thread in the server's order (start frame, then created, then id)", () => {
    const list = [thread("a", 10), thread("c", 90)];
    expect(upsertThread(list, thread("a", 10, { body: "new" })).map((t) => t.body)).toEqual(["new", "c"]);
    expect(upsertThread(list, thread("b", 50)).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(upsertThread(list, thread("z", 10, { createdAt: "2026-10-09T02:00:00.000Z" })).map((t) => t.id)).toEqual(["a", "z", "c"]);
  });
  it("re-sorts after an update that moves a note's start frame", () => {
    const list = [thread("a", 50), thread("b", 100)];
    expect(upsertThread(list, thread("a", 150, { revision: 2 })).map((t) => t.id)).toEqual(["b", "a"]);
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
    expect(failureText({ kind: "unreachable" })).not.toMatch(/nothing was changed/i);
    expect(failureText({ kind: "unreachable" })).toMatch(/may or may not have been saved/i);
    expect(failureText({ kind: "rejected", error: "not_author" })).toMatch(/your own/i);
    expect(failureText({ kind: "rejected", error: "frame_out_of_range" })).toMatch(/outside/i);
    expect(failureText({ kind: "rejected", error: "markup_too_large" })).toMatch(/too large/i);
    expect(failureText({ kind: "rejected", error: "whatever" })).toMatch(/couldn.t be saved/i);
  });
});

describe("editPatch", () => {
  const baseline = { doc: para("Old"), startFrame: 50, endFrame: null as number | null, hadDrawing: false };
  const base = { doc: para("Old"), marks: { in: 50, out: null as number | null }, frameCount: 1000, items: [] as MarkupItem[], drawingFrame: null as number | null, drawingRemoved: false, baseline };
  it("sends nothing when nothing changed", () => {
    expect(editPatch(base)).toEqual({ ok: true, patch: null });
  });
  it("sends the document as content only when it changed", () => {
    expect(editPatch({ ...base, doc: para("New") })).toEqual({ ok: true, patch: { content: para("New") } });
    expect(editPatch({ ...base, doc: { type: "doc", content: [...para("Old").content, image("m1")] } as RichTextDoc })).toMatchObject({ ok: true, patch: { content: expect.anything() } });
  });
  it("refuses an empty document", () => {
    expect(editPatch({ ...base, doc: para("   ") })).toMatchObject({ ok: false });
    expect(editPatch({ ...base, doc: para("") })).toMatchObject({ ok: false });
  });
  it("sends new frames, with a null end when a range becomes a point", () => {
    expect(editPatch({ ...base, marks: { in: 60, out: 80 } })).toEqual({ ok: true, patch: { startFrame: 60, endFrame: 81 } });
    expect(editPatch({ ...base, marks: { in: 60, out: null }, baseline: { ...baseline, endFrame: 90 } })).toEqual({ ok: true, patch: { startFrame: 60, endFrame: null } });
  });
  it("sends a redrawn drawing with its frame, and a removal as null", () => {
    expect(editPatch({ ...base, items: [stroke], drawingFrame: 50 })).toEqual({ ok: true, patch: { markup: [stroke], drawingFrame: 50 } });
    expect(editPatch({ ...base, baseline: { ...baseline, hadDrawing: true }, drawingRemoved: true })).toEqual({ ok: true, patch: { markup: null } });
  });
  it("never sends frames together with a drawing change (the server refuses both)", () => {
    expect(editPatch({ ...base, marks: { in: 60, out: null }, items: [stroke], drawingFrame: 60 })).toMatchObject({ ok: false });
    expect(editPatch({ ...base, marks: { in: 60, out: null }, baseline: { ...baseline, hadDrawing: true }, drawingRemoved: true })).toMatchObject({ ok: false });
  });
  it("refuses a drawing outside the note's frames", () => {
    expect(editPatch({ ...base, items: [stroke], drawingFrame: 51 })).toMatchObject({ ok: false, problem: expect.stringMatching(/drawing/i) });
  });
});

describe("openThreadCount", () => {
  it("counts the open roots: not resolved, and either not deleted or a tombstone that kept its replies; replies never count", () => {
    const reply = thread("r", 0, { parentId: "a", startFrame: null });
    expect(openThreadCount([])).toBe(0);
    expect(openThreadCount([
      thread("a", 10, { replies: [reply] as never }),
      thread("b", 20, { resolved: true }),
      thread("c", 30, { deleted: true, replies: [reply] as never }),
      thread("d", 40, { deleted: true }),
      thread("e", 50, { deleted: true, resolved: true, replies: [reply] as never }),
    ])).toBe(2);
  });
});
