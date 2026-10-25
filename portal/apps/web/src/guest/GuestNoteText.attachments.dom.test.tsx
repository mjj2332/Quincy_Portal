import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { GuestNoteDto } from "@quincy/shared";
import { NoteText } from "./GuestNoteItem";
import type { GuestMediaTransport } from "./guest-api";

/** #955: a Guest reviewer reads a public staff note's files as C4 download chips, downloaded from the Review link's own route, never the staff one. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const FILE = "44444444-4444-4444-8444-444444444444";
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

const media = { heicEnabled: false, video: true, mediaUrl: (id: string) => `/m/${id}`, posterUrl: (id: string) => `/p/${id}`, attachmentUrl: (id: string) => `/d/api/links/L/attachments/${id}` } as unknown as GuestMediaTransport;
const note = {
  id: "n1", parentId: null, author: { kind: "studio", name: "Studio" }, startFrame: 10, endFrame: null, drawingFrame: null, hasMarkup: false, body: "See the plan [1 file]", mediaCount: 0, deleted: false, revision: 1, resolved: false,
  createdAt: "2026-10-25T00:00:00.000Z", editedAt: null,
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "See the plan" }] }, { type: "attachment", attrs: { attachmentId: FILE, name: "Grade notes.pdf", bytes: 40_000 } }] },
} as unknown as GuestNoteDto;

describe("NoteText: a public staff note's files", () => {
  it("draws each file as a download chip at the Review link's Attachment route", () => {
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<NoteText note={note} media={media} />));
    const chips = [...host.querySelectorAll<HTMLElement>('[data-testid="attachment-chip"]')];
    expect(chips.map((chip) => [chip.getAttribute("href"), chip.getAttribute("aria-label")])).toEqual([[`/d/api/links/L/attachments/${FILE}`, "Download Grade notes.pdf, 40 KB"]]);
  });
});
