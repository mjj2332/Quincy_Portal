import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestNoteThreadDto, GuestSessionResponse, GuestVideoDto, RichTextDoc } from "@quincy/shared";
import { installVideoElementStub, type VideoElementStub } from "../testing/video-element";
import { mockViewport, type MockViewport } from "../testing/viewport";
import { GuestApp } from "./GuestApp";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

/**
 * The upload contract of the real field (`QuincyRichTextEditorBase`), in miniature: an attachment goes up in the background and, when it lands, is inserted into whatever the field
 * holds then (`insert` checks only that the upload was not cancelled and the field is still mounted; a content reset does not stop it). Only Remove or an unmount aborts it, and an
 * unmount tells the host it is no longer uploading. `uploads` holds each upload's `land`, and `aborted` counts the ones an unmount cut short.
 */
const uploads: Array<(mediaId: string) => void> = [];
let aborted = 0;
vi.mock("./GuestNoteEditor", async () => {
  const shared = await import("@quincy/shared");
  return {
    GuestNoteEditor: (props: { testId: string; id?: string; value: RichTextDoc; onChange: (doc: RichTextDoc) => void; onUploadingChange?: (uploading: boolean) => void; inlineStart?: import("react").ReactNode; inlineEnd?: import("react").ReactNode }) => {
      const latest = useRef(props); latest.current = props;
      const running = useRef(new Set<{ cancelled: boolean }>());
      useEffect(() => () => {
        for (const upload of running.current) { upload.cancelled = true; aborted += 1; }
        if (running.current.size > 0) latest.current.onUploadingChange?.(false);
        running.current.clear();
      }, []);
      const attach = () => {
        const upload = { cancelled: false };
        running.current.add(upload);
        latest.current.onUploadingChange?.(true);
        uploads.push((mediaId) => {
          if (upload.cancelled) return;
          running.current.delete(upload);
          const doc = latest.current.value;
          latest.current.onChange({ ...doc, content: [...(doc.content ?? []), { type: "image", attrs: { mediaId } }] } as RichTextDoc);
          if (running.current.size === 0) latest.current.onUploadingChange?.(false);
        });
      };
      const images = (props.value.content ?? []).filter((node) => node.type === "image").length;
      return <div>
        {props.inlineStart}
        <textarea data-testid={props.testId} id={props.id} data-images={images} value={shared.videoNoteBody(props.value)} onChange={(event) => { props.onChange(shared.legacyBodyToRichTextDoc(event.target.value)); }} />
        <button type="button" data-testid="stub-attach" onClick={attach}>Attach</button>
        {props.inlineEnd}
      </div>;
    },
  };
});

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE = `/d/api/links/${LINK}`;
const asset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SESSION: GuestSessionResponse = { link: { label: "Smith house", expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: true, approve: false, download: false, markup: true } }, verified: true, email: "sam@example.com", name: "Sam", notifications: null, media: { heic: false } };
const versionOf = (n: number) => ({
  assetId: asset(n), version: n, fps: { num: 25, den: 1 }, frameCount: 3000, durationMs: 120000, width: 1920, height: 1080, startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false,
  hasAudio: true, posterUrl: `${BASE}/versions/${asset(n)}/poster`, streamUrl: `${BASE}/versions/${asset(n)}/stream`, publicNoteCount: 0, decision: null, released: false, downloadUrl: null,
});
const VIDEO: GuestVideoDto = { id: "11111111-1111-4111-8111-000000000001", title: "Film 1", premium: false, unlocked: true, versions: [versionOf(11), versionOf(10)] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let stub: VideoElementStub;
let viewport: MockViewport;
let root: Root | null = null;
let host: HTMLElement;
const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** The box's Post note is off: `disabled`, or locked with a reason (`aria-disabled`, #927). */
const postOff = () => { const send = document.body.querySelector<HTMLButtonElement>('[data-testid="guest-composer"] button[aria-label="Post note"]')!; return send.disabled || send.getAttribute("aria-disabled") === "true"; };
const area = () => byId("guest-composer-body") as HTMLTextAreaElement | null;
const click = async (element: HTMLElement | null | undefined) => { expect(element).toBeTruthy(); await act(async () => { element!.click(); }); await flush(2); };
const typeInto = async (value: string) => {
  const field = area()!;
  await act(async () => { field.focus(); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(2);
};

beforeEach(() => {
  uploads.length = 0; aborted = 0;
  stub = installVideoElementStub();
  viewport = mockViewport({ width: 390, coarse: true });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${BASE}/session`) return json(SESSION);
    if (url === `${BASE}/videos`) return json({ videos: [VIDEO] });
    if (/\/notes$/.test(url)) return json({ notes: [] as GuestNoteThreadDto[] });
    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); stub.dispose(); viewport.restore();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("an attachment going up when the guest changes Version (#879 PR 2 fix round 5)", () => {
  it("is cut short with the old Version's draft: it never lands in the new Version's note", async () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=tok123`);
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<GuestApp token="tok123" />); });
    await flush();
    await vi.waitFor(() => { expect(area()).not.toBeNull(); });
    await typeInto("On v11");
    await click(byId("stub-attach"));
    expect(uploads).toHaveLength(1);
    expect(postOff()).toBe(true); // the picture is still going up

    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
    await flush(2);
    await click(byId("video-version-chip"));
    await click([...document.body.querySelectorAll<HTMLElement>('[data-testid="video-version-row"]')].find((row) => row.getAttribute("data-asset-id") === asset(10)));
    await vi.waitFor(() => { expect(area()).not.toBeNull(); });

    await typeInto("On v10");
    await act(async () => { uploads[0]!("m-late"); });
    await flush(2);
    expect(area()!.value).toBe("On v10");
    expect(area()!.getAttribute("data-images")).toBe("0");
    expect(postOff()).toBe(false);
    expect(aborted).toBe(1);
  });
});
