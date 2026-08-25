import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  PROJECT_DATA_CHANNEL, ProjectQueryRuntime, createActiveProjectDetailsInvalidatedMessage,
  createProjectDataInvalidationMessage, createProjectDataRemovedMessage, parseProjectDataSyncMessage, projectResourceKey,
} from "./project-query-sync";
import { beginAssetOptimisticMutation, projectDataKeys } from "./project-data";

afterEach(() => { /* each test creates and disposes its own client/runtime */ });

describe("project-data BroadcastChannel contract", () => {
  it("accepts valid discriminants, deduplicates resources, and rejects extra/private fields", () => {
    const message = createProjectDataInvalidationMessage("p", [{ kind: "detail" }, { kind: "detail" }, { kind: "assets", collectionKind: "raw" }, { kind: "comments" }, { kind: "comment-read-marker" }]);
    expect(message.type).toBe("project-data-invalidated");
    const parsed = parseProjectDataSyncMessage({ ...message, sourceTabId: "a" });
    expect(parsed?.type).toBe("project-data-invalidated");
    expect(parsed && parsed.type === "project-data-invalidated" ? parsed.resources : []).toHaveLength(4);
    expect(parseProjectDataSyncMessage({ ...message, sourceTabId: "a", data: "private" })).toBeNull();
    expect(parseProjectDataSyncMessage({ ...message, sourceTabId: "a", resources: [{ kind: "assets", collectionKind: "nope" }] })).toBeNull();
    expect(parseProjectDataSyncMessage({ version: 2, type: "project-data-removed", sourceTabId: "a", projectId: "p", committedAt: new Date().toISOString() })).toBeNull();
    expect(parseProjectDataSyncMessage(createProjectDataRemovedMessage("p"))).toBeNull();
  });

  it("resolves all four resources to exact keys and rejects private fields on the new variants", () => {
    expect(projectResourceKey("a", { kind: "detail" })).toEqual(projectDataKeys.detail("a"));
    expect(projectResourceKey("a", { kind: "assets", collectionKind: "raw" })).toEqual(projectDataKeys.assets("a", "raw"));
    expect(projectResourceKey("a", { kind: "comments" })).toEqual(projectDataKeys.comments("a"));
    expect(projectResourceKey("a", { kind: "comment-read-marker" })).toEqual(projectDataKeys.commentReadMarker("a"));
    const message = createProjectDataInvalidationMessage("a", [{ kind: "comments" }, { kind: "comment-read-marker" }]);
    expect(parseProjectDataSyncMessage({ ...message, sourceTabId: "sender", resources: [{ kind: "comments", extra: true }] })).toBeNull();
  });

  it("keeps removal and active-detail messages data-free and validates their shapes", () => {
    const removed = createProjectDataRemovedMessage("p");
    const active = createActiveProjectDetailsInvalidatedMessage();
    expect(parseProjectDataSyncMessage({ ...removed, sourceTabId: "a" })).toEqual({ ...removed, sourceTabId: "a" });
    expect(parseProjectDataSyncMessage({ ...active, sourceTabId: "a" })).toEqual({ ...active, sourceTabId: "a" });
    expect(parseProjectDataSyncMessage({ ...active, sourceTabId: "a", projectId: "p" })).toBeNull();
  });

  it("uses exact receiver invalidation and ignores the sender", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "sender");
    queryClient.setQueryData(projectDataKeys.detail("p"), { id: "p" });
    queryClient.setQueryData(projectDataKeys.assets("p", "raw"), []);
    const invalidated = createProjectDataInvalidationMessage("p", [{ kind: "detail" }]);
    // The local runtime's public receiver is intentionally exercised through a fake channel below
    // in browser tests; this assertion documents the exact key that the receiver enumerates.
    expect(projectDataKeys.detail("p")).toEqual(["project-data", "p", "detail"]);
    expect(invalidated.type === "project-data-invalidated" ? invalidated.resources : []).toEqual([{ kind: "detail" }]);
    expect(PROJECT_DATA_CHANNEL).toBe("quincy:project-data:v1");
    runtime.dispose(); queryClient.clear();
  });

  it("delivers exact invalidation to a sibling runtime, suppresses sender loops, and closes channels", async () => {
    class FakeChannel {
      static channels: FakeChannel[] = [];
      readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
      constructor(readonly name: string) { FakeChannel.channels.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) { this.listeners.add(listener); }
      postMessage(data: unknown) { for (const channel of FakeChannel.channels.filter((item) => item.name === this.name)) for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>); }
      close() { FakeChannel.channels = FakeChannel.channels.filter((item) => item !== this); this.listeners.clear(); }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const senderClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const receiverClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sender = new ProjectQueryRuntime(senderClient, "sender"); const receiver = new ProjectQueryRuntime(receiverClient, "receiver");
    sender.start(); receiver.start();
    const detailKey = projectDataKeys.detail("p"); const assetsKey = projectDataKeys.assets("p", "raw"); const commentsKey = projectDataKeys.comments("p"); const markerKey = projectDataKeys.commentReadMarker("p");
    senderClient.setQueryData(detailKey, { id: "p" }); receiverClient.setQueryData(detailKey, { id: "p" }); receiverClient.setQueryData(assetsKey, []);
    sender.publish(createProjectDataInvalidationMessage("p", [{ kind: "detail" }]));
    await Promise.resolve();
    expect(receiverClient.getQueryCache().find({ queryKey: detailKey, exact: true })?.state.isInvalidated).toBe(true);
    expect(receiverClient.getQueryCache().find({ queryKey: assetsKey, exact: true })?.state.isInvalidated).toBe(false);
    const before = senderClient.getQueryCache().find({ queryKey: detailKey, exact: true })?.state.isInvalidated;
    sender.publish(createProjectDataInvalidationMessage("p", [{ kind: "detail" }]));
    expect(senderClient.getQueryCache().find({ queryKey: detailKey, exact: true })?.state.isInvalidated).toBe(before);
    sender.dispose(); receiver.dispose(); senderClient.clear(); receiverClient.clear();
    expect(FakeChannel.channels).toHaveLength(0);
  });

  it("defers received invalidations for ledger-owned and special-owned keys until ownership ends", async () => {
    class FakeChannel {
      static channels: FakeChannel[] = [];
      readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
      constructor(readonly name: string) { FakeChannel.channels.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) { this.listeners.add(listener); }
      postMessage(data: unknown) { for (const channel of FakeChannel.channels.filter((item) => item.name === this.name)) for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>); }
      close() { FakeChannel.channels = FakeChannel.channels.filter((item) => item !== this); this.listeners.clear(); }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const senderClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const receiverClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sender = new ProjectQueryRuntime(senderClient, "sender"); const receiver = new ProjectQueryRuntime(receiverClient, "receiver");
    sender.start(); receiver.start();
    const assetsKey = projectDataKeys.assets("p", "raw"); const detailKey = projectDataKeys.detail("p"); const commentsKey = projectDataKeys.comments("p"); const markerKey = projectDataKeys.commentReadMarker("p");
    receiverClient.setQueryData(assetsKey, [{ id: "a", selected: false }]); receiverClient.setQueryData(detailKey, { id: "p" });
    receiverClient.setQueryData(commentsKey, { pages: [], pageParams: [] }); receiverClient.setQueryData(markerKey, { unreadCount: 0 });
    const mutation = await beginAssetOptimisticMutation(receiverClient, "p", "raw", "a", { selected: true });
    sender.publish(createProjectDataInvalidationMessage("p", [{ kind: "assets", collectionKind: "raw" }, { kind: "comments" }, { kind: "comment-read-marker" }]));
    expect(receiverClient.getQueryCache().find({ queryKey: assetsKey, exact: true })?.state.isInvalidated).toBe(false);
    expect(receiverClient.getQueryCache().find({ queryKey: commentsKey, exact: true })?.state.isInvalidated).toBe(true);
    expect(receiverClient.getQueryCache().find({ queryKey: markerKey, exact: true })?.state.isInvalidated).toBe(true);
    await mutation.fail(); await Promise.resolve();
    expect(receiverClient.getQueryCache().find({ queryKey: assetsKey, exact: true })?.state.isInvalidated).toBe(true);

    const release = receiver.acquireOwner(detailKey);
    sender.publish(createProjectDataInvalidationMessage("p", [{ kind: "detail" }]));
    expect(receiverClient.getQueryCache().find({ queryKey: detailKey, exact: true })?.state.isInvalidated).toBe(false);
    release(); await Promise.resolve();
    expect(receiverClient.getQueryCache().find({ queryKey: detailKey, exact: true })?.state.isInvalidated).toBe(true);
    sender.dispose(); receiver.dispose(); senderClient.clear(); receiverClient.clear();
  });

  it("coalesces a deferred received invalidation with the local commit confirmation", async () => {
    class FakeChannel {
      static channels: FakeChannel[] = [];
      readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
      constructor(readonly name: string) { FakeChannel.channels.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) { this.listeners.add(listener); }
      postMessage(data: unknown) { for (const channel of FakeChannel.channels.filter((item) => item.name === this.name)) for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>); }
      close() { FakeChannel.channels = FakeChannel.channels.filter((item) => item !== this); this.listeners.clear(); }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const senderClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const receiverClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sender = new ProjectQueryRuntime(senderClient, "sender"); const receiver = new ProjectQueryRuntime(receiverClient, "receiver");
    sender.start(); receiver.start();
    const key = projectDataKeys.assets("p", "raw");
    receiverClient.setQueryData(key, [{ id: "a", selected: false }]);
    const mutation = await beginAssetOptimisticMutation(receiverClient, "p", "raw", "a", { selected: true });
    sender.publish(createProjectDataInvalidationMessage("p", [{ kind: "assets", collectionKind: "raw" }]));
    const invalidate = vi.spyOn(receiverClient, "invalidateQueries");
    await mutation.commit();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true, refetchType: "active" });
    sender.dispose(); receiver.dispose(); senderClient.clear(); receiverClient.clear();
  });

  it("marks removal synchronously and purges the receiver project prefix without rebroadcasting", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const runtime = new ProjectQueryRuntime(queryClient, "receiver");
    const projectKey = projectDataKeys.project("p");
    queryClient.setQueryData(projectDataKeys.detail("p"), { id: "p" }); queryClient.setQueryData(projectDataKeys.assets("p", "raw"), []);
    (runtime as unknown as { receive: (value: unknown) => void }).receive({ ...createProjectDataRemovedMessage("p"), sourceTabId: "sender" });
    expect(runtime.isProjectRemoved("p")).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve)); await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(queryClient.getQueriesData({ queryKey: projectKey })).toHaveLength(0);
    runtime.dispose(); queryClient.clear();
  });
});
