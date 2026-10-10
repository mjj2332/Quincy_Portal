import { describe, expect, it } from "vitest";
import type { GuestNoteThreadDto } from "@quincy/shared";
import { defaultSource, pastableNotes, pasteFailureText } from "./guest-paste";

const version = (n: number) => ({ assetId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, version: n }) as Parameters<typeof defaultSource>[1];
const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const thread = (n: number, over: Partial<GuestNoteThreadDto> = {}): GuestNoteThreadDto => ({
  id: id(n), parentId: null, author: { kind: "guest", name: "Sam", self: true }, startFrame: 1, endFrame: null, drawingFrame: null, hasMarkup: false, body: "x", deleted: false, resolved: false, revision: 1,
  createdAt: "2026-10-09T01:00:00.000Z", editedAt: null, replies: [], ...over,
});

describe("defaultSource", () => {
  const all = [version(3), version(2), version(1)];
  it("is the Version just before the target, else the newest other", () => {
    expect(defaultSource(all, version(3))?.version).toBe(2);
    expect(defaultSource(all, version(2))?.version).toBe(1);
    expect(defaultSource(all, version(1))?.version).toBe(3);
  });
  it("is null when there is no other Version", () => { expect(defaultSource([version(1)], version(1))).toBeNull(); });
});

describe("pastableNotes", () => {
  it("keeps the guest's own live root notes and nothing else", () => {
    const list = [thread(1), thread(2, { author: { kind: "studio", name: "Mia" } }), thread(3, { author: { kind: "guest", name: "Pat", self: false } }), thread(4, { deleted: true }), thread(5, { parentId: id(1) })];
    expect(pastableNotes(list, true)).toEqual({ ids: [id(1)], drawn: 0, capped: false });
  });
  it("leaves drawn notes out and counts them when markup is off", () => {
    const list = [thread(1), thread(2, { hasMarkup: true })];
    expect(pastableNotes(list, false)).toEqual({ ids: [id(1)], drawn: 1, capped: false });
    expect(pastableNotes(list, true).ids).toEqual([id(1), id(2)]);
  });
  it("asks for at most 60 and says it left some off", () => {
    const list = Array.from({ length: 61 }, (_, n) => thread(n + 1));
    const result = pastableNotes(list, true);
    expect([result.ids.length, result.capped]).toEqual([60, true]);
  });
});

describe("pasteFailureText", () => {
  it("words a limit, a dropped connection and a refusal, and leaves the page-level answers to the page", () => {
    expect(pasteFailureText({ kind: "limited", retryAfterSeconds: 30 }, "commit")).toContain("30 seconds");
    expect(pasteFailureText({ kind: "unreachable" }, "commit")).toContain("never makes a second copy");
    expect(pasteFailureText({ kind: "unreachable" }, "preview")).not.toContain("second copy");
    expect(pasteFailureText({ kind: "rejected", error: "same_version" }, "commit")).toContain("can't be pasted");
    expect(pasteFailureText({ kind: "unverified" }, "commit")).toBeNull();
    expect(pasteFailureText({ kind: "gone" }, "commit")).toBeNull();
    expect(pasteFailureText({ kind: "archived" }, "commit")).toBeNull();
  });
});
