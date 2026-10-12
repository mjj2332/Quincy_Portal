import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIDEO_NOTE_BODY_MAX } from "@quincy/shared";
import type { QuincyRichTextEditor } from "../QuincyRichTextEditor";
import type { VideoNoteEditor as Editor } from "./VideoNoteEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ apiGet: vi.fn(), externalApiGet: vi.fn() }));
vi.mock("../../lib/api", () => ({ apiGet: api.apiGet }));
vi.mock("../../lib/external-api-response", () => ({ externalApiGet: api.externalApiGet }));
const seen = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("../QuincyRichTextEditor", () => ({ QuincyRichTextEditor: (props: Record<string, unknown>) => { seen.props = props; return <div data-testid="rte" />; } }));
const { VideoNoteEditor } = await import("./VideoNoteEditor");

const P = "11111111-1111-4111-8111-111111111111";
let root: Root; let host: HTMLElement;
const doc = { type: "doc" as const, content: [{ type: "paragraph" as const }] };
async function render(over: Partial<ComponentProps<typeof Editor>> = {}) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<VideoNoteEditor projectId={P} role="editor" value={doc} onChange={vi.fn()} {...over} />); });
  return seen.props as ComponentProps<typeof QuincyRichTextEditor>;
}
beforeEach(() => { Object.values(api).forEach((mock) => mock.mockReset()); seen.props = null; });
afterEach(async () => { await act(async () => { root.unmount(); }); document.body.replaceChildren(); });

describe("VideoNoteEditor (#835)", () => {
  it("uploads as the note's own media, with no link previews, and caps the text at the note limit", async () => {
    const props = await render();
    expect(props.media).toEqual({ projectId: P, owner: "video_note" });
    expect(props.linkPreviews).toBeUndefined();
    expect(props.limit).toBe(VIDEO_NOTE_BODY_MAX);
  });

  it("@ lists the Project's video audience, through the staff or the External route by role", async () => {
    api.apiGet.mockResolvedValue({ users: [{ id: "u1", name: "Mia" }] });
    const staff = await render();
    expect(await staff.loadMentionables("mi a")).toEqual([{ id: "u1", name: "Mia" }]);
    expect(api.apiGet).toHaveBeenCalledWith(`/api/mentionable-users?scope=video&projectId=${P}&q=mi%20a`);
    await act(async () => { root.unmount(); }); document.body.replaceChildren();
    api.externalApiGet.mockResolvedValue({ users: [] });
    const external = await render({ role: "external_editor" });
    await external.loadMentionables("x");
    expect(api.externalApiGet).toHaveBeenCalledWith("mentionable", `/api/mentionable-users?scope=video&projectId=${P}&q=x`);
  });
});
