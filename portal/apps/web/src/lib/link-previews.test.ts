import { beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ apiPost }));

import { requestLinkPreview } from "./link-previews";

const ID = "11111111-1111-4111-8111-111111111111";
const card = { previewId: ID, url: "https://example.test/a", title: "T", description: null, siteName: "example.test", imageMediaId: null };

beforeEach(() => apiPost.mockReset());

describe("requestLinkPreview (#497)", () => {
  it("asks the Project's route and returns the card the server made", async () => {
    apiPost.mockResolvedValue({ preview: card });
    await expect(requestLinkPreview({ projectId: "p 1" }, "https://example.test/a")).resolves.toEqual(card);
    expect(apiPost).toHaveBeenCalledWith("/api/projects/p%201/link-previews", { url: "https://example.test/a" });
  });

  it("asks the Notice board's route for a notice", async () => {
    apiPost.mockResolvedValue({ preview: card });
    await requestLinkPreview({ noticeBoard: true }, "https://example.test/a");
    expect(apiPost.mock.calls[0]![0]).toBe("/api/notice-board/link-previews");
  });

  it("answers no card when the page has none, when the limit is hit, or when the request fails: the link just stays a link", async () => {
    apiPost.mockResolvedValueOnce({ preview: null });
    await expect(requestLinkPreview({ noticeBoard: true }, "https://example.test/a")).resolves.toBeNull();
    apiPost.mockRejectedValueOnce(Object.assign(new Error("Too many link previews. Try again later."), { status: 429 }));
    await expect(requestLinkPreview({ noticeBoard: true }, "https://example.test/a")).resolves.toBeNull();
    apiPost.mockRejectedValueOnce(new Error("offline"));
    await expect(requestLinkPreview({ projectId: "p" }, "https://example.test/a")).resolves.toBeNull();
  });

  it("answers no card for a response that does not match the contract", async () => {
    apiPost.mockResolvedValue({ preview: { previewId: "not-a-uuid" } });
    await expect(requestLinkPreview({ projectId: "p" }, "https://example.test/a")).resolves.toBeNull();
  });
});
