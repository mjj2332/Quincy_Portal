import { describe, expect, it } from "vitest";
import type { VideoNoteDto, VideoNoteThreadDto } from "@quincy/shared";
import { authorKey, DEFAULT_NOTE_FILTERS, isHiddenTombstone, isOwnNote, matchesQuery, noteAnchorLabel, noteAuthors, noteCounts, removeThread, upsertThread, visibleThreads, type NoteFilters } from "./video-note-view";

const person = (id: string) => ({ id, name: id, roleLabel: "Editor", isExternal: false, active: true });
let seq = 0;
const note = (over: Record<string, unknown> = {}): VideoNoteThreadDto => {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return { id, assetId: "a", parentId: null, author: { kind: "staff", person: person("u1") }, authorRole: "editor", visibility: "internal", startFrame: 10, endFrame: null, drawingFrame: null, mediaCount: 0, hasMarkup: false, body: "hi", deleted: false, resolved: null, revision: 1, createdAt: "2026-10-10T00:00:00.000Z", editedAt: null, copiedFrom: null, replies: [], ...over } as VideoNoteThreadDto;
};
const reply = (over: Record<string, unknown> = {}): VideoNoteDto => { const { replies: _replies, ...rest } = note({ startFrame: null, ...over }); return rest; };
const resolvedBy = { at: "2026-10-10T01:00:00.000Z", by: person("u1") };
const tc = (frame: number) => `TC${frame}`;

describe("video-note-view (#741 5b)", () => {
  const open = note({ visibility: "public" });
  const openInternal = note({ visibility: "internal" });
  const done = note({ visibility: "public", resolved: resolvedBy });
  const doneInternal = note({ visibility: "internal", resolved: resolvedBy });
  const all = [open, openInternal, done, doneInternal];

  it("filters status x visibility", () => {
    const f = (status: "open" | "resolved" | "all", visibility: "all" | "public" | "internal") => visibleThreads(all, { ...DEFAULT_NOTE_FILTERS, status, visibility }).map((t) => t.id);
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

  it("the default filters are Open x All, Everyone, search closed", () => {
    expect(DEFAULT_NOTE_FILTERS).toEqual({ status: "open", visibility: "all", author: null, query: null });
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
    const counts = noteCounts([...all, withReplies], { ...DEFAULT_NOTE_FILTERS, status: "open", visibility: "public" });
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

describe("video-note-view: author and search (#879 PR 3b)", () => {
  const guestAuthor = (id: string, name: string) => ({ kind: "guest", id, name });
  const mara = { kind: "staff", person: { ...person("u-mara"), name: "Mara Lind" } };
  const ola = { kind: "staff", person: { ...person("u-ola"), name: "Ola Brandt" } };
  const byMara = note({ author: mara, body: "Lift the shadows on the porch", visibility: "public" });
  const byOla = note({ author: ola, body: "Trim the drone shot", replies: [reply({ author: mara, body: "Agreed, the PORCH too" })] });
  const byGuest = note({ author: guestAuthor("g-1", "Sam Reyes"), body: "Love the kitchen", visibility: "public", resolved: resolvedBy });
  const tombstone = note({ author: ola, deleted: true, body: "", replies: [reply({ author: mara, body: "Kept reply" })] });
  const bare = note({ author: guestAuthor("g-2", "Hidden Person"), deleted: true, body: "" });
  const list = [byMara, byOla, byGuest, tombstone, bare];
  const f = (over: Partial<NoteFilters>): NoteFilters => ({ ...DEFAULT_NOTE_FILTERS, status: "all", ...over });

  it("an author key names the kind and the stable id", () => {
    expect(authorKey(mara as never)).toBe("staff:u-mara");
    expect(authorKey(guestAuthor("g-1", "Sam") as never)).toBe("guest:g-1");
  });

  it("the author options are the live roots' authors, once each, sorted by name; a reply-only author, a tombstone's and a hidden one's are not offered", () => {
    const extra = note({ author: mara, body: "second by Mara" });
    expect(noteAuthors([...list, extra])).toEqual([
      { key: "staff:u-mara", name: "Mara Lind" },
      { key: "guest:g-1", name: "Sam Reyes" },
      { key: "staff:u-ola", name: "Ola Brandt" },
    ].sort((a, b) => a.name.localeCompare(b.name)));
    expect(noteAuthors([byOla]).map((option) => option.key)).toEqual(["staff:u-ola"]);
  });

  it("filters by the root's author", () => {
    expect(visibleThreads(list, f({ author: "staff:u-mara" })).map((t) => t.id)).toEqual([byMara.id]);
    expect(visibleThreads(list, f({ author: "guest:g-1" })).map((t) => t.id)).toEqual([byGuest.id]);
  });

  it("search is a trimmed, case-insensitive literal over the root's body, live replies and author names; a deleted note contributes nothing", () => {
    expect(matchesQuery(byMara, null)).toBe(true);
    expect(matchesQuery(byMara, "   ")).toBe(true);
    expect(visibleThreads(list, f({ query: "  porch " })).map((t) => t.id)).toEqual([byMara.id, byOla.id]);
    expect(visibleThreads(list, f({ query: "sam reyes" })).map((t) => t.id)).toEqual([byGuest.id]);
    expect(visibleThreads(list, f({ query: "kept reply" })).map((t) => t.id)).toEqual([tombstone.id]);
    // A literal: regex characters match themselves only.
    expect(visibleThreads(list, f({ query: ".*" })).map((t) => t.id)).toEqual([]);
    // The tombstone's author wrote nothing searchable any more; the hidden tombstone is never listed.
    expect(visibleThreads([tombstone], f({ query: "Ola" })).map((t) => t.id)).toEqual([]);
    expect(visibleThreads(list, f({ query: "hidden" })).map((t) => t.id)).toEqual([]);
  });

  it("each axis is counted under the other three; the totals ignore all four", () => {
    const counts = noteCounts(list, { status: "open", visibility: "public", author: "staff:u-mara", query: "porch" });
    // Status under public + Mara + porch: byMara (open).
    expect(counts.status).toEqual({ open: 1, resolved: 0, all: 1 });
    // Visibility under open + Mara + porch: byMara (public).
    expect(counts.visibility).toEqual({ all: 1, public: 1, internal: 0 });
    expect(counts.totals).toEqual({ open: 3, resolved: 1 });
    const searchOnly = noteCounts(list, f({ query: "porch" }));
    expect(searchOnly.status).toEqual({ open: 2, resolved: 0, all: 2 });
  });
});
