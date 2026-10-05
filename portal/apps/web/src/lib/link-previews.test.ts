import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ apiPost }));

import { requestLinkPreview } from "./link-previews";

const ID = "11111111-1111-4111-8111-111111111111";
const card = { previewId: ID, url: "https://example.test/a", title: "T", description: null, siteName: "example.test", imageMediaId: null };

beforeEach(() => apiPost.mockReset());
afterEach(() => { vi.useRealTimers(); });
const inProgress = () => Object.assign(new Error("This link is already being previewed."), { status: 409, details: { code: "link_preview_in_progress" } });

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

  it("waits a moment and asks once more when the same link is already being fetched, then returns the stored card", async () => {
    vi.useFakeTimers();
    apiPost.mockRejectedValueOnce(inProgress()).mockResolvedValueOnce({ preview: card });
    const pending = requestLinkPreview({ projectId: "p" }, "https://example.test/a");
    await vi.advanceTimersByTimeAsync(0);
    expect(apiPost.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(card);
    expect(apiPost.mock.calls).toHaveLength(2);
  });

  it("retries only once, and gives no card if it is still in progress", async () => {
    vi.useFakeTimers();
    apiPost.mockRejectedValueOnce(inProgress()).mockRejectedValueOnce(inProgress());
    const pending = requestLinkPreview({ projectId: "p" }, "https://example.test/a");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeNull();
    expect(apiPost.mock.calls).toHaveLength(2);
  });

  it("does not retry a 409 that is not the in-progress answer", async () => {
    apiPost.mockRejectedValueOnce(Object.assign(new Error("Archived"), { status: 409, details: { code: "project_archived" } }));
    await expect(requestLinkPreview({ projectId: "p" }, "https://example.test/a")).resolves.toBeNull();
    expect(apiPost.mock.calls).toHaveLength(1);
  });
});
