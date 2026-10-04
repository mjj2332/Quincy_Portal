import { beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.hoisted(() => vi.fn());
const uploadMultipartFile = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ apiPost }));
vi.mock("./multipart-upload", () => ({ uploadMultipartFile }));

import { uploadEmbeddedImage } from "./embedded-media";

const file = new File([new Uint8Array(8)], "a.png", { type: "image/png" });
const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  apiPost.mockReset(); uploadMultipartFile.mockReset();
  apiPost.mockImplementation(async (path: string) => path.endsWith("/complete") ? { mediaId: ID, state: "pending" } : { mediaId: ID, devDirect: true });
  uploadMultipartFile.mockResolvedValue({});
});

describe("uploadEmbeddedImage scopes (#496)", () => {
  it("uploads a Project image under the Project's media routes", async () => {
    await expect(uploadEmbeddedImage({ projectId: "p 1" }, file)).resolves.toBe(ID);
    expect(apiPost.mock.calls.map((call) => call[0])).toEqual(["/api/projects/p%201/embedded-media", `/api/projects/p%201/embedded-media/${ID}/complete`]);
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`/api/projects/p%201/embedded-media/${ID}/direct`);
  });

  it("uploads a Notice board image under the Notice board media routes", async () => {
    await expect(uploadEmbeddedImage({ noticeBoard: true }, file)).resolves.toBe(ID);
    expect(apiPost.mock.calls.map((call) => call[0])).toEqual(["/api/notice-board/embedded-media", `/api/notice-board/embedded-media/${ID}/complete`]);
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`/api/notice-board/embedded-media/${ID}/direct`);
  });
});
