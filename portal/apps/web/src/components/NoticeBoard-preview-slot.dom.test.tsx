import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { NoticeBoard, type NoticeBoardPost } from "./NoticeBoard";
import { createQuincyQueryClient } from "../lib/query-client";
import { chooseNoticeAction } from "../testing/notice-menu";

/**
 * Owner decision B1 (#944): a notice's Link preview cards render under the box's text, in its previews region, in the new-notice box and
 * the edit box alike. The editor is replaced by a recorder of its props, so this pins the host's wiring (`previewContainer`); the editor's
 * own slot behaviour is `QuincyRichTextEditor-preview-slot.dom.test.tsx`.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const editors = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("./QuincyRichTextEditor", async () => {
  const { forwardRef } = await vi.importActual<typeof import("react")>("react");
  return { QuincyRichTextEditor: forwardRef((props: Record<string, unknown>, _ref) => { editors.push(props); return <div data-testid="recorded-editor" />; }) };
});
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: () => Promise.resolve({}), apiPatch: () => Promise.resolve({}), apiDelete: () => Promise.resolve({ ok: true }) };
});

const readState = { marker: null, latest: null, unreadCount: 0 };
const ownPost: NoticeBoardPost = { id: "post-own", authorId: "user-a", authorName: "A", body: "Rota", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Rota" }] }] }, createdAt: "2026-07-28T00:00:00.000Z", editedAt: null };

let root: Root | null = null;
let queryClient: ReturnType<typeof createQuincyQueryClient> | null = null;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await advance(1); await Promise.resolve(); }); }

/** The last render's props of the editor inside `scope`'s box, and that box. */
function wiredIn(scope: HTMLElement) {
  const box = scope.querySelector<HTMLElement>('[data-testid="note-composer-box"]')!;
  const props = [...editors].reverse().find((candidate) => candidate.previewContainer instanceof HTMLElement && box.contains(candidate.previewContainer as HTMLElement));
  return { box, props };
}

beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  editors.length = 0;
  queryClient = createQuincyQueryClient();
  apiGetMock.mockReset().mockImplementation((path) => Promise.resolve(path.includes("read-marker") ? readState : { posts: [ownPost] }));
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; queryClient?.clear(); queryClient = null; document.body.replaceChildren(); vi.useRealTimers();
});

describe("a notice's Link preview cards sit under the box's text (B1)", () => {
  it("in the new-notice box and the edit box: each editor is given its own box's previews region, outside the text", async () => {
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<QueryClientProvider client={queryClient!}><NoticeBoard currentUserId="user-a" /></QueryClientProvider>); for (let index = 0; index < 12; index += 1) await Promise.resolve(); });
    await flush();

    const create = wiredIn(host.querySelector<HTMLElement>('[data-slot="notice-board-composer"]')!);
    expect(create.props?.linkPreviews).toEqual({ noticeBoard: true });
    expect(create.box.querySelector('[data-testid="note-composer-text"]')!.contains(create.props!.previewContainer as HTMLElement)).toBe(false);

    await chooseNoticeAction(host, "A", "Edit", advance);
    const edit = wiredIn(host.querySelector<HTMLElement>('[data-slot="notice-board-edit-composer"]')!);
    expect(edit.props?.linkPreviews).toEqual({ noticeBoard: true });
    expect(edit.box.querySelector('[data-testid="note-composer-text"]')!.contains(edit.props!.previewContainer as HTMLElement)).toBe(false);
    expect(edit.props!.previewContainer).not.toBe(create.props!.previewContainer);
  });
});
