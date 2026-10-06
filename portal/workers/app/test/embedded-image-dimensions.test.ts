import { beforeAll, describe, expect, it } from "vitest";
import { database, displayJpeg, heicBytes, ids, mediaRow, request, seedFixture, seedMedia } from "./embedded-media-support";

/** Embedded image dimensions (#611): captured at completion, served from the media record, never stored in the post. */
const PROJECT_MEDIA = `/api/projects/${ids.project}/embedded-media`;
const NOTICE_MEDIA = "/api/notice-board/embedded-media";
const sizeOf = async (id: string) => { const row = (await mediaRow(id))!; return { width: row.width, height: row.height }; };
const setDisplaySize = (id: string, width: number | null, height: number | null) => database.DB.prepare("UPDATE embedded_media SET display_width = ?, display_height = ? WHERE id = ?").bind(width, height, id).run();
const setSize = (id: string, width: number | null, height: number | null) => database.DB.prepare("UPDATE embedded_media SET width = ?, height = ? WHERE id = ?").bind(width, height, id).run();
type Node = { type: string; attrs?: Record<string, unknown> };

beforeAll(async () => { await seedFixture(); });

describe.each([
  ["a Project upload", async (id: string, body: unknown) => request(`${PROJECT_MEDIA}/${id}/complete`, "member", "POST", body), (extra: Parameters<typeof seedMedia>[0] = {}) => seedMedia({ state: "uploading", ...extra })],
  ["a Notice board upload", async (id: string, body: unknown) => request(`${NOTICE_MEDIA}/${id}/complete`, "member", "POST", body), (extra: Parameters<typeof seedMedia>[0] = {}) => seedMedia({ ownerKind: "notice_post", state: "uploading", ...extra })],
] as const)("completing %s with the size the browser measured", (_name, complete, reserve) => {
  it("stores the width and height of an image, and leaves them null when none came", async () => {
    const withSize = await reserve(); const without = await reserve();
    expect((await complete(withSize.id, { width: 511, height: 384 })).status).toBe(200);
    expect((await complete(without.id, {})).status).toBe(200);
    expect(await sizeOf(withSize.id)).toEqual({ width: 511, height: 384 });
    expect(await sizeOf(without.id)).toEqual({ width: null, height: null });
  });

  it("refuses a size that is half given, not a positive whole number, or absurdly large, and leaves the upload reserved", async () => {
    for (const body of [{ width: 511 }, { height: 384 }, { width: 0, height: 5 }, { width: -1, height: 5 }, { width: 1.5, height: 5 }, { width: "5", height: 5 }, { width: 32769, height: 5 }, { width: null, height: 5 }, { width: 5, height: 5, extra: 1 }]) {
      const { id } = await reserve();
      const response = await complete(id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await mediaRow(id))!.state, JSON.stringify(body)).toBe("uploading");
      expect(await sizeOf(id)).toEqual({ width: null, height: null });
    }
  });

  it("does not record a size for a HEIC (its size is its display copy's), and a repeated completion keeps the first size", async () => {
    const heic = await reserve({ contentType: "image/heic", object: heicBytes(), bytes: 4096, renditionStatus: "pending", uploader: ids.member });
    const response = await complete(heic.id, { width: 4032, height: 3024 });
    // A HEIC completes only when the gate is open; either way no size is written for it.
    expect([200, 403, 503]).toContain(response.status);
    expect(await sizeOf(heic.id)).toEqual({ width: null, height: null });
    const png = await reserve();
    await complete(png.id, { width: 100, height: 50 });
    await complete(png.id, { width: 999, height: 999 });
    expect(await sizeOf(png.id)).toEqual({ width: 100, height: 50 });
  });
});

describe("serving an image's size (#611)", () => {
  const imageNode = (mediaId: string, alt?: string): Node => ({ type: "image", attrs: { mediaId, ...(alt ? { alt } : {}) } });
  const doc = (...nodes: Node[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Look" }] }, ...nodes] });
  const images = (content: Node[]) => content.filter((node) => node.type === "image").map((node) => node.attrs);
  const postComment = async (content: unknown) => { const response = await request(`/api/projects/${ids.project}/comments`, "member", "POST", { content }); expect(response.status).toBe(201); return (await response.json()) as { id: string; content: { content: Node[] } }; };

  it("fills a comment's image with the recorded size when it is served, lists it again with the size, and stores only the id and alt", async () => {
    const sized = (await seedMedia({ state: "pending" })).id; const legacy = (await seedMedia({ state: "pending" })).id;
    await setSize(sized, 511, 384);
    // The browser echoes a size it was served, and a wrong one is ignored: the server trusts only the media record.
    const sent = doc({ type: "image", attrs: { mediaId: sized, alt: "Front", width: 1, height: 1 } }, imageNode(legacy));
    const comment = await postComment(sent);
    expect(images(comment.content.content)).toEqual([{ mediaId: sized, alt: "Front", width: 511, height: 384 }, { mediaId: legacy }]);
    const stored = await database.DB.prepare("SELECT content_json FROM project_comments WHERE id = ?").bind(comment.id).first<{ content_json: string }>();
    expect(images(JSON.parse(stored!.content_json).content)).toEqual([{ mediaId: sized, alt: "Front" }, { mediaId: legacy }]);
    const listed = (await (await request(`/api/projects/${ids.project}/comments`, "member")).json()) as { comments: Array<{ id: string; content: { content: Node[] } }> };
    expect(images(listed.comments.find((item) => item.id === comment.id)!.content.content)).toEqual([{ mediaId: sized, alt: "Front", width: 511, height: 384 }, { mediaId: legacy }]);
  });

  it("gives a HEIC image its display copy's size, and nothing while the copy has no size", async () => {
    const ready = (await seedMedia({ contentType: "image/heic", object: heicBytes(), bytes: 4096, renditionStatus: "ready", display: displayJpeg() })).id;
    const unsized = (await seedMedia({ contentType: "image/heic", object: heicBytes(), bytes: 4096, renditionStatus: "ready", display: displayJpeg() })).id;
    await setDisplaySize(ready, 4096, 3072); await setDisplaySize(unsized, null, null);
    const comment = await postComment(doc(imageNode(ready), imageNode(unsized)));
    expect(images(comment.content.content)).toEqual([{ mediaId: ready, width: 4096, height: 3072 }, { mediaId: unsized }]);
  });

  it("never serves half a size", async () => {
    const half = (await seedMedia({ state: "pending" })).id;
    await setSize(half, 511, null);
    expect(images((await postComment(doc(imageNode(half)))).content.content)).toEqual([{ mediaId: half }]);
  });

  it("serves a Notice board post's images the same way", async () => {
    const sized = (await seedMedia({ ownerKind: "notice_post", state: "pending" })).id;
    await setSize(sized, 640, 480);
    const created = await request("/api/notice-board/posts", "member", "POST", { content: doc(imageNode(sized)) });
    expect(created.status).toBe(201);
    const listed = (await (await request("/api/notice-board/posts", "member")).json()) as { posts: Array<{ content: { content: Node[] } }> };
    expect(listed.posts.flatMap((post) => images(post.content.content))).toContainEqual({ mediaId: sized, width: 640, height: 480 });
  });
});
