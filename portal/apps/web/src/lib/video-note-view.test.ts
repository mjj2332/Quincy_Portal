import { describe, expect, it } from "vitest";
import type { VideoNoteThreadDto } from "@quincy/shared";
import { DEFAULT_NOTE_FILTERS, isHiddenTombstone, isOwnNote, noteAnchorLabel, noteCounts, removeThread, upsertThread, visibleThreads } from "./video-note-view";

const person = (id: string) => ({ id, name: id, roleLabel: "Editor", isExternal: false, active: true });
let seq = 0;
const note = (over: Record<string, unknown> = {}): VideoNoteThreadDto => {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return { id, assetId: "a", parentId: null, author: { kind: "staff", person: person("u1") }, authorRole: "editor", visibility: "internal", startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false, body: "hi", deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:00.000Z", editedAt: null, copiedFrom: null, replies: [], ...over } as VideoNoteThreadDto;
};
const reply = (over: Record<string, unknown> = {}) => ({ ...note({ startFrame: null, ...over }), replies: undefined } as never);
const resolvedBy = { at: "2026-10-10T01:00:00.000Z", by: person("u1") };
const tc = (frame: number) => `TC${frame}`;

describe("video-note-view (#741 5b)", () => {
  const open = note({ visibility: "public" });
  const openInternal = note({ visibility: "internal" });
  const done = note({ visibility: "public", resolved: resolvedBy });
  const doneInternal = note({ visibility: "internal", resolved: resolvedBy });
  const all = [open, openInternal, done, doneInternal];

  it("filters status x visibility", () => {
    const f = (status: "open" | "resolved" | "all", visibility: "all" | "public" | "internal") => visibleThreads(all, { status, visibility }).map((t) => t.id);
    expect(f("open", "all")).toEqual([open.id, openInternal.id]);
    expect(f("resolved", "all")).toEqual([done.id, doneInternal.id]);
    expect(f("all", "all")).toEqual(all.map((t) => t.id));
    expect(f("open", "public")).toEqual([open.id]);
    expect(f("open", "internal")).toEqual([openInternal.id]);
    expect(f("resolved", "public")).toEqual([done.id]);
    expect(f("resolved", "internal")).toEqual([doneInternal.id]);
    expect(f("all", "public")).toEqual([open.id, done.id]);
    expect(f("all", "internal")).toEqual([openInternal.id, doneInternal.id]);
  });

  it("the default filters are Open x All", () => {
    expect(DEFAULT_NOTE_FILTERS).toEqual({ status: "open", visibility: "all" });
  });

  it("a tombstone with replies is shown (and resolvable); one without replies is hidden everywhere", () => {
    const withReplies = note({ deleted: true, body: "", replies: [reply()] });
    const bare = note({ deleted: true, body: "" });
    expect(isHiddenTombstone(withReplies)).toBe(false);
    expect(isHiddenTombstone(bare)).toBe(true);
    expect(visibleThreads([withReplies, bare], DEFAULT_NOTE_FILTERS).map((t) => t.id)).toEqual([withReplies.id]);
    const counts = noteCounts([withReplies, bare], DEFAULT_NOTE_FILTERS);
    expect(counts.totals).toEqual({ open: 1, resolved: 0 });
  });

  it("counts roots only, honest under the other axis", () => {
    const withReplies = note({ replies: [reply(), reply()] });
    const counts = noteCounts([...all, withReplies], { status: "open", visibility: "public" });
    // Status counts are taken under the visibility filter (public): open = open(1), resolved = done(1).
    expect(counts.status).toEqual({ open: 1, resolved: 1, all: 2 });
    // Visibility counts are taken under the status filter (open): public 1, internal 2 (openInternal + withReplies).
    expect(counts.visibility).toEqual({ all: 3, public: 1, internal: 2 });
    expect(counts.totals).toEqual({ open: 3, resolved: 2 });
  });

  it("isOwnNote: staff own, staff other, guest never", () => {
    expect(isOwnNote(note(), "u1")).toBe(true);
    expect(isOwnNote(note(), "u2")).toBe(false);
    expect(isOwnNote(note({ author: { kind: "guest", id: "u1", name: "G" } }), "u1")).toBe(false);
    expect(isOwnNote(note(), null)).toBe(false);
  });

  it("noteAnchorLabel: a point is one timecode, a range ends at end - 1", () => {
    expect(noteAnchorLabel(note({ startFrame: 10, endFrame: null }), tc)).toBe("TC10");
    expect(noteAnchorLabel(note({ startFrame: 10, endFrame: 21 }), tc)).toBe("TC10 → TC20");
  });

  it("upsertThread keeps 5a order (startFrame, createdAt, id) and re-sorts on a frame edit", () => {
    const a = note({ startFrame: 5 }); const b = note({ startFrame: 20 }); const c = note({ startFrame: 20, createdAt: "2026-10-10T00:00:01.000Z" });
    let list = upsertThread([], b);
    list = upsertThread(list, c);
    list = upsertThread(list, a);
    expect(list.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    list = upsertThread(list, { ...a, startFrame: 25, revision: 2 });
    expect(list.map((t) => t.id)).toEqual([b.id, c.id, a.id]);
    expect(list.at(-1)!.revision).toBe(2);
    expect(list).toHaveLength(3);
  });

  it("upsertThread orders replies by createdAt then id", () => {
    const r1 = reply({ createdAt: "2026-10-10T00:00:02.000Z" }); const r2 = reply({ createdAt: "2026-10-10T00:00:01.000Z" });
    const [root] = upsertThread([], note({ replies: [r1, r2] }));
    expect(root!.replies.map((r) => r.id)).toEqual([r2.id, r1.id]);
  });

  it("removeThread drops by root id", () => {
    expect(removeThread(all, open.id).map((t) => t.id)).toEqual([openInternal.id, done.id, doneInternal.id]);
    expect(removeThread(all, "nope")).toHaveLength(4);
  });
});
