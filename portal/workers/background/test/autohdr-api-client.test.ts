import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTOHDR_API_BASE_URL,
  createAutoHdrPresignedPhotoshoot,
  finalizeAutoHdrPhotoshoot,
  uploadAutoHdrPresignedFile,
} from "../src/autohdr/api-client";

afterEach(() => vi.unstubAllGlobals());

describe("AutoHDR API client", () => {
  it("creates a presigned photoshoot with Bearer auth and no retrieval callbacks", async () => {
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      uid: "shoot-123",
      uploaded_files: ["https://uploads.example/one", "https://uploads.example/two"],
    }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createAutoHdrPresignedPhotoshoot("secret-key", {
      files: [{ filename: "one.jpg" }, { filename: "two.jpg" }],
      address: "1 Quincy Street, Sydney, 2000",
    })).resolves.toEqual({
      uid: "shoot-123",
      uploadedFiles: ["https://uploads.example/one", "https://uploads.example/two"],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${AUTOHDR_API_BASE_URL}/create-photoshoot-with-presigned-urls`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      files: [{ filename: "one.jpg" }, { filename: "two.jpg" }],
      address: "1 Quincy Street, Sydney, 2000",
    });
    expect(body).not.toHaveProperty("upload_callback_url");
    expect(body).not.toHaveProperty("status_callback_url");
  });

  it("uploads bytes without leaking Authorization to the presigned URL", async () => {
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await uploadAutoHdrPresignedFile("https://uploads.example/photo", new Uint8Array([1, 2, 3]), "image/jpeg");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://uploads.example/photo");
    expect(init?.method).toBe("PUT");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("image/jpeg");
    expect(headers.has("authorization")).toBe(false);
  });

  it("finalizes the photoshoot with the uid and Bearer auth", async () => {
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await finalizeAutoHdrPhotoshoot("secret-key", "shoot-123");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${AUTOHDR_API_BASE_URL}/finalize-photoshoot-upload`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-key");
    expect(JSON.parse(String(init?.body))).toEqual({ uid: "shoot-123" });
  });

  it("rejects malformed create responses instead of uploading to an unknown destination", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ uid: "shoot-123", uploaded_files: [] }), { status: 201 })));
    await expect(createAutoHdrPresignedPhotoshoot("secret-key", { files: [{ filename: "one.jpg" }] }))
      .rejects.toThrow("one upload URL per selected photo");
  });
});
