import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { L1, L2, PROJECT, linkOf } from "@/testing/review-links-harness";
import { createReviewLinkActions, reviewLinksKey } from "./review-links-data";

const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, apiGet: () => new Promise(() => {}), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});

afterEach(() => { apiPostMock.mockReset(); apiDeleteMock.mockReset(); });

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
