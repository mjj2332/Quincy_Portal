import { describe, expect, it } from "vitest";
import type { GuestNoteThreadDto } from "@quincy/shared";
import { GUEST_PHONE_FILTERS, guestAuthorKey, guestNoteAuthors, guestNoteCounts, guestVisibleThreads, type GuestNoteFilters } from "./guest-notes-filter";

let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
type Over = Partial<Omit<GuestNoteThreadDto, "replies">> & { replies?: GuestNoteThreadDto["replies"] };
const note = (over: Over = {}): GuestNoteThreadDto => ({
  id: id(), parentId: null, author: { kind: "guest", name: "Gina", self: true }, startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false,
  body: "A note", deleted: false, revision: 1, resolved: false, createdAt: "2026-10-10T00:00:00.000Z", editedAt: null, replies: [], ...over,
});
const reply = (root: GuestNoteThreadDto, over: Over = {}) => { const { replies: _r, ...rest } = note({ parentId: root.id, startFrame: null, ...over }); return rest; };

const gina = note({ body: "Logo too small" });
const studio = note({ author: { kind: "studio", name: "Quincy" }, body: "Graded the sky", resolved: true });
const otherGina = note({ author: { kind: "guest", name: "Gina", self: false }, body: "Second Gina" });
const benBase = note({ author: { kind: "guest", name: "Ben", self: false }, body: "Music cue" });
const ben = { ...benBase, replies: [reply(benBase, { author: { kind: "studio", name: "Quincy" }, body: "Swapped the TRACK" })] };
const bareTomb = note({ author: { kind: "guest", name: "Zed", self: false }, body: "", deleted: true });
const tombBase = note({ author: { kind: "guest", name: "Yan", self: false }, body: "", deleted: true });
const tomb = { ...tombBase, replies: [reply(tombBase, { body: "Still relevant" })] };
const all = [gina, studio, otherGina, ben, bareTomb, tomb];
const ids = (list: readonly GuestNoteThreadDto[]) => list.map((thread) => thread.id);
const f = (over: Partial<GuestNoteFilters> = {}): GuestNoteFilters => ({ ...GUEST_PHONE_FILTERS, ...over });

describe("guest notes filter (#879 PR 3b)", () => {
  it("a phone guest starts on Open: resolved roots and bare tombstones are hidden, a tombstone with replies stays", () => {
    expect(GUEST_PHONE_FILTERS).toEqual({ status: "open", author: null, query: null });
    expect(ids(guestVisibleThreads(all, f(), new Set()))).toEqual(ids([gina, otherGina, ben, tomb]));
    expect(ids(guestVisibleThreads(all, f({ status: "resolved" }), new Set()))).toEqual(ids([studio]));
    expect(ids(guestVisibleThreads(all, f({ status: "all" }), new Set()))).toEqual(ids([gina, studio, otherGina, ben, tomb]));
  });

  it("authors are live roots' authors, keyed kind:name, so two guests of one name merge and a studio note never merges with a guest", () => {
    expect(guestAuthorKey(gina.author)).toBe("guest:Gina");
    expect(guestAuthorKey(studio.author)).toBe("studio:Quincy");
    expect(guestNoteAuthors(all)).toEqual([{ key: "guest:Ben", name: "Ben" }, { key: "guest:Gina", name: "Gina" }, { key: "studio:Quincy", name: "Quincy" }]);
    expect(ids(guestVisibleThreads(all, f({ author: "guest:Gina" }), new Set()))).toEqual(ids([gina, otherGina]));
  });

  it("search is trimmed, case-insensitive and literal over root bodies, live reply bodies and author names", () => {
    expect(ids(guestVisibleThreads(all, f({ query: "  logo " }), new Set()))).toEqual(ids([gina]));
    expect(ids(guestVisibleThreads(all, f({ query: "track" }), new Set()))).toEqual(ids([ben]));
    expect(ids(guestVisibleThreads(all, f({ query: "quincy", status: "all" }), new Set()))).toEqual(ids([studio, ben]));
    expect(ids(guestVisibleThreads(all, f({ query: "still" }), new Set()))).toEqual(ids([tomb]));
    expect(ids(guestVisibleThreads(all, f({ query: "(" }), new Set()))).toEqual([]);
    expect(ids(guestVisibleThreads(all, f({ query: "" }), new Set()))).toEqual(ids(guestVisibleThreads(all, f(), new Set())));
  });

  it("a pinned root (an edit or reply open on it) survives every filter, in its place; a bare tombstone never shows", () => {
    expect(ids(guestVisibleThreads(all, f({ query: "music" }), new Set([gina.id])))).toEqual(ids([gina, ben]));
    expect(ids(guestVisibleThreads(all, f(), new Set([bareTomb.id])))).toEqual(ids([gina, otherGina, ben, tomb]));
  });

  it("status counts are taken under the author and the search, never under status itself", () => {
    expect(guestNoteCounts(all, f())).toEqual({ open: 4, resolved: 1, all: 5 });
    expect(guestNoteCounts(all, f({ status: "resolved", author: "studio:Quincy" }))).toEqual({ open: 0, resolved: 1, all: 1 });
    expect(guestNoteCounts(all, f({ query: "gina" }))).toEqual({ open: 3, resolved: 0, all: 3 }); // both Ginas, and the tombstone Gina replied to
  });
});
