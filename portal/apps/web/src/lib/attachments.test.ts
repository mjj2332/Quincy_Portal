import { beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.hoisted(() => vi.fn());
const uploadMultipartFile = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), apiPost }));
vi.mock("./multipart-upload", () => ({ uploadMultipartFile }));

import { ApiError } from "./api";
import { ATTACHMENT_MAX_BYTES } from "@quincy/shared";
import { attachmentKindFor, attachmentProblem, attachmentUrl, isAttachmentRefusal, isEmbeddedMediaFile, uploadAttachment } from "./attachments";

const ID = "11111111-1111-4111-8111-111111111111";
const named = (name: string, type = "", bytes = 8) => ({ name, type, size: bytes });

beforeEach(() => {
  apiPost.mockReset(); uploadMultipartFile.mockReset();
  apiPost.mockImplementation(async (path: string) => path.endsWith("/complete") ? { attachmentId: ID, state: "pending" } : { attachmentId: ID, devDirect: true });
  uploadMultipartFile.mockResolvedValue({});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
});

describe("which path a picked file takes (#952 D8)", () => {
  it("sends JPEG, PNG and WebP down Embedded media, and HEIC only for someone who may upload it", () => {
    for (const file of [named("a.jpg", "image/jpeg"), named("a.png", "image/png"), named("a.webp", "image/webp")]) expect(isEmbeddedMediaFile(file, { heic: false, video: true })).toBe(true);
    expect(isEmbeddedMediaFile(named("IMG_1.HEIC"), { heic: true, video: true })).toBe(true);
    expect(isEmbeddedMediaFile(named("IMG_1.HEIC"), { heic: false, video: true })).toBe(false);
  });
  it("sends MP4 and MOV down Embedded media only where the surface takes video", () => {
    expect(isEmbeddedMediaFile(named("clip.mp4", "video/mp4"), { heic: false, video: true })).toBe(true);
    expect(isEmbeddedMediaFile(named("clip.MOV"), { heic: false, video: true })).toBe(true);
    expect(isEmbeddedMediaFile(named("clip.mp4", "video/mp4"), { heic: false, video: false })).toBe(false);
  });
  it("makes everything else a file, by type and never by size (A3)", () => {
    for (const file of [named("a.gif", "image/gif"), named("a.tif", "image/tiff"), named("a.dng"), named("a.webm", "video/webm"), named("a.pdf", "application/pdf"), named("README")]) {
      expect(isEmbeddedMediaFile(file, { heic: false, video: true })).toBe(false);
    }
    expect(isEmbeddedMediaFile(named("huge.jpg", "image/jpeg", 500 * 1024 * 1024), { heic: false, video: true })).toBe(true);
  });
});

describe("attachmentProblem", () => {
  it("names a blocked extension or type", () => {
    expect(attachmentProblem(named("setup.exe"))).toBe("setup.exe can't be attached: .exe files are blocked.");
    expect(attachmentProblem(named("page", "text/html"))).toBe("page can't be attached: text/html files are blocked.");
    expect(attachmentProblem(named("Budget.XLSM"))).toBe("Budget.XLSM can't be attached: .xlsm files are blocked.");
  });
  it("names an empty file and one over the limit", () => {
    expect(attachmentProblem(named("a.pdf", "application/pdf", 0))).toBe("a.pdf is empty.");
    expect(attachmentProblem(named("a.pdf", "application/pdf", ATTACHMENT_MAX_BYTES + 1))).toBe("a.pdf is larger than 100 MB, the most a file can be.");
    expect(attachmentProblem(named("a.pdf", "application/pdf", ATTACHMENT_MAX_BYTES))).toBeNull();
  });
  it("refuses a name with nothing usable left", () => {
    expect(attachmentProblem(named("..."))).toBe("This file has no usable name.");
  });
});

describe("attachmentKindFor", () => {
  it("names the icon by extension", () => {
    expect(attachmentKindFor("Floor plan.PDF")).toBe("pdf");
    expect(attachmentKindFor("a.xlsx")).toBe("sheet");
    expect(attachmentKindFor("a.csv")).toBe("sheet");
    expect(attachmentKindFor("a.docx")).toBe("document");
    expect(attachmentKindFor("a.txt")).toBe("document");
    expect(attachmentKindFor("a.key")).toBe("slides");
    expect(attachmentKindFor("a.zip")).toBe("archive");
    expect(attachmentKindFor("a.dng")).toBe("image");
    expect(attachmentKindFor("a.wav")).toBe("audio");
    expect(attachmentKindFor("a.webm")).toBe("video");
    expect(attachmentKindFor("README")).toBe("file");
  });
});

describe("uploadAttachment over the staff routes", () => {
  it("presigns with the file's name, type and size, puts the bytes and completes", async () => {
    const file = new File([new Uint8Array(8)], "Plan.pdf", { type: "application/pdf" });
    await expect(uploadAttachment("p 1", file)).resolves.toBe(ID);
    expect(apiPost.mock.calls.map((call) => call[0])).toEqual(["/api/projects/p%201/attachments", `/api/projects/p%201/attachments/${ID}/complete`]);
    expect(apiPost.mock.calls[0]![1]).toEqual({ name: "Plan.pdf", contentType: "application/pdf", bytes: 8 });
    expect(uploadMultipartFile.mock.calls[0]![2]).toBe(`/api/projects/p%201/attachments/${ID}/direct`);
  });
  it("reports byte progress over the controlled path", async () => {
    uploadMultipartFile.mockImplementation(async (_file, _presign, _url, _progress, control) => { control.onBytes(4, 8); return {}; });
    const seen: number[] = [];
    await uploadAttachment("p1", new File([new Uint8Array(8)], "a.zip"), { onProgress: (percent) => seen.push(percent) });
    expect(seen).toEqual([50]);
  });
  it("aborts the reservation when the bytes fail, and passes the error on", async () => {
    uploadMultipartFile.mockRejectedValue(new Error("Part 1 could not be uploaded."));
    await expect(uploadAttachment("p1", new File([new Uint8Array(8)], "a.zip"))).rejects.toThrow("Part 1 could not be uploaded.");
    expect(fetch).toHaveBeenCalledWith(`/api/projects/p1/attachments/${ID}/abort`, expect.objectContaining({ method: "POST", keepalive: true }));
  });
  it("aborts the reservation on a cancel", async () => {
    const controller = new AbortController();
    uploadMultipartFile.mockImplementation(async () => { controller.abort(); throw Object.assign(new Error("Upload cancelled"), { name: "AbortError" }); });
    await expect(uploadAttachment("p1", new File([new Uint8Array(8)], "a.zip"), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledWith(`/api/projects/p1/attachments/${ID}/abort`, expect.anything());
  });
  it("reads a 4xx presign as a refusal, and a 5xx or network failure as worth a Retry", async () => {
    apiPost.mockRejectedValueOnce(new ApiError("setup.exe can't be attached: .exe files are blocked.", 400, { code: "attachment_blocked" }));
    const refused = await uploadAttachment("p1", new File([new Uint8Array(8)], "a.zip")).catch((error: unknown) => error);
    expect(isAttachmentRefusal(refused)).toBe(true);
    expect(isAttachmentRefusal(new ApiError("down", 503))).toBe(false);
    expect(isAttachmentRefusal(new ApiError("slow", 429))).toBe(false);
    expect(isAttachmentRefusal(new Error("Part 1 could not be uploaded."))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("names the download route by id only", () => {
    expect(attachmentUrl("a b")).toBe("/media/attachments/a%20b");
  });
});
