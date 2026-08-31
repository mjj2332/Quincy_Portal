import { afterEach, describe, expect, it, vi } from "vitest";
import { externalProjectActivityFeedResponseSchema, projectActivityFeedResponseSchema } from "@quincy/shared";
import { projectDataKeys } from "./project-data";

const apiGetMock = vi.hoisted(() => vi.fn());
const externalApiGetMock = vi.hoisted(() => vi.fn());
const useInfiniteQueryMock = vi.hoisted(() => vi.fn(() => ({ data: undefined })));
const sessionState = vi.hoisted(() => ({ role: "editor" as string }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), apiGet: apiGetMock }));
vi.mock("./external-api-response", async (importOriginal) => ({ ...(await importOriginal<typeof import("./external-api-response")>()), externalApiGet: externalApiGetMock }));
vi.mock("./auth", () => ({ useSession: () => ({ data: { user: { role: sessionState.role } } }) }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tanstack/react-query")>()), useInfiniteQuery: useInfiniteQueryMock }));

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const internalItem = {
  id: projectId,
  type: "project.comment.created" as const,
  category: "comment" as const,
  occurredAt: 1_700_000_000_000,
  presentation: { title: "Project comment added", body: "A project comment was added." },
  actor: { id: projectId, name: "Ting" },
};
const { actor: _actor, ...externalItem } = internalItem;

afterEach(() => {
  apiGetMock.mockReset();
  externalApiGetMock.mockReset();
  useInfiniteQueryMock.mockClear();
  sessionState.role = "editor";
});

describe("project activity query family", () => {
  it("uses the activity key, exact limit, signal, strict internal decoding, and next cursor", async () => {
    const options = (await import("./project-activity")).projectActivityInfiniteQueryOptions(projectId);
    const signal = new AbortController().signal;
    apiGetMock.mockResolvedValueOnce({ items: [internalItem], nextCursor: "older" }).mockResolvedValueOnce({ items: [], nextCursor: null });
    expect(options.queryKey).toEqual(projectDataKeys.activity(projectId));
    await options.queryFn({ pageParam: null, signal, client: undefined, queryKey: options.queryKey, meta: undefined } as never);
    await options.queryFn({ pageParam: "older", signal, client: undefined, queryKey: options.queryKey, meta: undefined } as never);
    expect(apiGetMock.mock.calls).toEqual([
      [`/api/projects/${projectId}/activity?limit=30`, { signal }],
      [`/api/projects/${projectId}/activity?limit=30&before=older`, { signal }],
    ]);
    expect(options.getNextPageParam({ items: [internalItem], nextCursor: "older" })).toBe("older");
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
    apiGetMock.mockResolvedValueOnce({ items: [internalItem], nextCursor: null, unexpected: true });
    await expect(options.queryFn({ pageParam: null, signal, client: undefined, queryKey: options.queryKey, meta: undefined } as never)).rejects.toThrow();
  });

  it("uses externalApiGet and the strict External response schema for External Editors", async () => {
    const { projectActivityInfiniteQueryOptions } = await import("./project-activity");
    const options = projectActivityInfiniteQueryOptions(projectId, true);
    const signal = new AbortController().signal;
    externalApiGetMock.mockResolvedValueOnce({ items: [externalItem], nextCursor: null });
    await options.queryFn({ pageParam: null, signal, client: undefined, queryKey: options.queryKey, meta: undefined } as never);
    expect(externalApiGetMock).toHaveBeenCalledWith("activity", `/api/projects/${projectId}/activity?limit=30`, signal);
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(() => externalProjectActivityFeedResponseSchema.parse({ items: [internalItem], nextCursor: null })).toThrow();
    expect(() => projectActivityFeedResponseSchema.parse({ items: [internalItem], nextCursor: null, unexpected: true })).toThrow();
  });

  it("configures the hook for 30-second freshness, polling, focus/reconnect refresh, and role branching", async () => {
    const { useProjectActivityQuery } = await import("./project-activity");
    sessionState.role = "external_editor";
    useProjectActivityQuery(projectId, true);
    expect(useInfiniteQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: projectDataKeys.activity(projectId), staleTime: 30_000, refetchInterval: 30_000,
      refetchIntervalInBackground: false, refetchOnWindowFocus: true, refetchOnReconnect: true,
    }));
  });
});
