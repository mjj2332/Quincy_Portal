import { afterEach, describe, expect, it, vi } from "vitest";
import { apiDeleteWithBody, apiPutWithStatus } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("membership transport helpers", () => {
  it("preserves the PUT response status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ outcome: "created" }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiPutWithStatus<{ outcome: string }>("/api/projects/p/photographers/u")).resolves.toEqual({ data: { outcome: "created" }, status: 201 });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", credentials: "include" });
  });

  it("sends one JSON DELETE body through the shared request path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ outcome: "removed" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { membershipCycle: "cycle", clearSubtaskAssignments: false, confirmedAssignmentCount: 0 };

    await expect(apiDeleteWithBody<{ outcome: string }, typeof body>("/api/projects/p/editors/u", body)).resolves.toEqual({ outcome: "removed" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "DELETE",
      credentials: "include",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  });
});
