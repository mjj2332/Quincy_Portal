import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { L1, L2, PROJECT, linkOf } from "@/testing/review-links-harness";
import { ApiError } from "./api";
import { onPrincipalTerminal } from "./principal-terminal";
import { projectDataKeys } from "./project-data";
import { createReviewLinkActions, reviewLinksKey } from "./review-links-data";

const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPatchMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, apiGet: () => new Promise(() => {}), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiDelete: (path: string) => apiDeleteMock(path), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body) };
});

afterEach(() => { apiPostMock.mockReset(); apiDeleteMock.mockReset(); apiPatchMock.mockReset(); });

const reveal = (id: string) => ({ link: linkOf({ id }), url: `https://example.test/d/${id}#t` });

describe("review link writes and the list cache", () => {
  it("a create that lands before the list ever loaded still puts its link in the cache, so Done can manage it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiPostMock.mockResolvedValue(reveal(L1));
    await createReviewLinkActions(client, PROJECT).create({} as never);
    expect((client.getQueryData(reviewLinksKey(PROJECT)) as Array<{ id: string }> | undefined)?.map((l) => l.id)).toEqual([L1]);
  });

  it("an upsert into a loaded list replaces or prepends", async () => {
    const client = new QueryClient();
    client.setQueryData(reviewLinksKey(PROJECT), [linkOf({ id: L2 })]);
    apiPostMock.mockResolvedValue(reveal(L1));
    await createReviewLinkActions(client, PROJECT).create({} as never);
    expect((client.getQueryData(reviewLinksKey(PROJECT)) as Array<{ id: string }>).map((l) => l.id)).toEqual([L1, L2]);
  });

  it("a removal never invents a list that was never loaded", async () => {
    const client = new QueryClient();
    apiDeleteMock.mockResolvedValue(undefined);
    await createReviewLinkActions(client, PROJECT).removeVideo(L1, "v");
    expect(client.getQueryData(reviewLinksKey(PROJECT))).toBeUndefined();
  });
});

describe("review link write refusals end or refresh what they should, with no component mounted (#741 11b round 10)", () => {
  const detailHeld = { id: PROJECT, archivedAt: null };
  it("a 401 ends the originating principal's session: its private data and every open form are dropped", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(reviewLinksKey(PROJECT), [linkOf({ id: L1 })]);
    const ended: unknown[] = [];
    const off = onPrincipalTerminal((terminated) => { ended.push(terminated); });
    apiPostMock.mockRejectedValue(new ApiError("Unauthorized", 401));
    await expect(createReviewLinkActions(client, PROJECT).create({} as never)).rejects.toBeInstanceOf(ApiError);
    off();
    expect(ended).toContain(client);
    await vi.waitFor(() => { expect(client.getQueryData(reviewLinksKey(PROJECT))).toBeUndefined(); });
  });

  it.each([[403, { error: "Forbidden" }], [404, { error: "Not found" }]])("a %s access refusal also invalidates the Project detail, not only the gate", async (status, body) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(projectDataKeys.detail(PROJECT), detailHeld);
    client.setQueryData(projectDataKeys.videoReview(PROJECT), { open: true, parts: ["links"] });
    apiPatchMock.mockRejectedValue(new ApiError(String(body.error), status, body));
    await expect(createReviewLinkActions(client, PROJECT).patch(L1, {} as never)).rejects.toBeInstanceOf(ApiError);
    expect(client.getQueryState(projectDataKeys.detail(PROJECT))?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectDataKeys.videoReview(PROJECT))?.isInvalidated).toBe(true);
  });

  it("a 409 project_archived records the archive in the cached Project, then re-reads it; Revoke is untouched", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(projectDataKeys.detail(PROJECT), detailHeld);
    client.setQueryData(reviewLinksKey(PROJECT), [linkOf({ id: L1 })]);
    apiPatchMock.mockRejectedValue(new ApiError("Archived", 409, { code: "project_archived" }));
    await expect(createReviewLinkActions(client, PROJECT).patch(L1, {} as never)).rejects.toBeInstanceOf(ApiError);
    expect((client.getQueryData(projectDataKeys.detail(PROJECT)) as { archivedAt: string | null }).archivedAt).toBeTruthy();
    expect(client.getQueryState(projectDataKeys.detail(PROJECT))?.isInvalidated).toBe(true);
    apiPostMock.mockResolvedValue({ link: linkOf({ id: L1, status: "revoked", revokedAt: "2026-10-10T03:00:00.000Z" }) });
    await expect(createReviewLinkActions(client, PROJECT).revoke(L1)).resolves.toBeDefined();
  });
});
